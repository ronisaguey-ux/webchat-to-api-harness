'use strict';
// Unit layer for src/runtime/spend_ledger.js — the only thing between a looping
// model and an unbounded bill.
//
// WHY THIS FILE EXISTS. search_spend.test.js proves the cap fires through the real
// search_web path, but only for the HOURLY cap, and only by spending its way there.
// The daily cap, the on-disk pruning, and the amount validation that stops a bad
// number from corrupting the running total had no coverage at all.
//
// This is the module whose failure mode is silent: a cap that stops firing does not
// raise, it just quietly spends. Every case below was run against the module before
// being written down; the comments record the MEASURED result.
//
// The ledger file is redirected to a temp dir through SPEND_LEDGER_FILE, and `now` is
// passed explicitly everywhere, so nothing here depends on the wall clock and the real
// ledger in RATE_LIMIT_STATE_DIR is never touched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-ledger-'));
const LEDGER = path.join(TMP, 'spend.json');
process.env.SPEND_LEDGER_FILE = LEDGER;
const ledger = require('../src/runtime/spend_ledger');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000; // fixed clock; nothing below reads Date.now()

function writeLedger(entries) {
    fs.writeFileSync(LEDGER, JSON.stringify({ entries }));
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── where the file is and what the caps are ───────────────────────────────────

test('the ledger path comes from SPEND_LEDGER_FILE, resolved absolutely', () => {
  assert.strictEqual(ledger.ledgerFile(), LEDGER);
  const prev = process.env.SPEND_LEDGER_FILE;
  process.env.SPEND_LEDGER_FILE = './relative-spend.json';
  try {
    assert.ok(path.isAbsolute(ledger.ledgerFile()), 'a relative path would depend on cwd');
  } finally { process.env.SPEND_LEDGER_FILE = prev; }
});

test('the caps default to $2/hour and $10/day', () => {
  const prevH = process.env.PAID_SPEND_HOUR_USD;
  const prevD = process.env.PAID_SPEND_DAY_USD;
  delete process.env.PAID_SPEND_HOUR_USD;
  delete process.env.PAID_SPEND_DAY_USD;
  try {
    assert.deepStrictEqual(ledger.caps(), { hourUsd: 2, dayUsd: 10 });
  } finally {
    if (prevH !== undefined) process.env.PAID_SPEND_HOUR_USD = prevH;
    if (prevD !== undefined) process.env.PAID_SPEND_DAY_USD = prevD;
  }
});

test('a cap that is not a usable number falls back to the default', () => {
  const prev = process.env.PAID_SPEND_HOUR_USD;
  try {
    // MEASURED: 'abc' -> 2, '-1' -> 2, 'Infinity' -> 2. A negative cap would refuse
    // every call, so it must not be taken literally.
    for (const v of ['abc', '-1', 'Infinity', 'NaN']) {
      process.env.PAID_SPEND_HOUR_USD = v;
      assert.strictEqual(ledger.caps().hourUsd, 2, `PAID_SPEND_HOUR_USD=${v}`);
    }
    process.env.PAID_SPEND_HOUR_USD = '2.5';
    assert.strictEqual(ledger.caps().hourUsd, 2.5);
  } finally {
    if (prev === undefined) delete process.env.PAID_SPEND_HOUR_USD;
    else process.env.PAID_SPEND_HOUR_USD = prev;
  }
});

test('FOOTGUN: an EMPTY cap variable means $0, not the default', () => {
  // MEASURED: `PAID_SPEND_HOUR_USD=` in a .env parses to Number('') === 0, which is
  // finite and >= 0, so the cap becomes zero and every paid call is refused. That is
  // the right reading for an explicit `=0` kill switch and the wrong one for an empty
  // assignment. Pinned as measured behaviour; whether to treat "" as unset is a
  // product decision, not a test decision.
  const prev = process.env.PAID_SPEND_HOUR_USD;
  try {
    process.env.PAID_SPEND_HOUR_USD = '';
    assert.strictEqual(ledger.caps().hourUsd, 0);
    process.env.PAID_SPEND_HOUR_USD = '0';
    assert.strictEqual(ledger.caps().hourUsd, 0, 'an explicit 0 is honoured as a kill switch');
  } finally {
    if (prev === undefined) delete process.env.PAID_SPEND_HOUR_USD;
    else process.env.PAID_SPEND_HOUR_USD = prev;
  }
});

// ── record(): what is allowed into the running total ───────────────────────────

test('record() appends an entry and totals it', () => {
  writeLedger([]);
  ledger.record(1.5, 'a search', NOW);
  const t = ledger.totals(NOW);
  assert.strictEqual(t.hourUsd, 1.5);
  assert.strictEqual(t.dayUsd, 1.5);
});

test('record() refuses an amount that is not a positive finite number', () => {
  // MEASURED: every one of these leaves the file at { entries: [] }. This is the
  // invariant that stops a bad usage number from pushing the running total negative
  // and switching the cap off.
  writeLedger([]);
  for (const v of [-5, 0, NaN, 'abc', Infinity, -0.01, null, undefined]) {
    ledger.record(v, 'probe', NOW);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(LEDGER, 'utf8')).entries, [],
      `record(${String(v)}) must not be written`);
  }
});

test('record() truncates the label so the ledger stays small', () => {
  // MEASURED: 40 characters, spaces included.
  writeLedger([]);
  ledger.record(1, 'x'.repeat(200), NOW);
  const e = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).entries[0];
  assert.strictEqual(e.what.length, 40);
});

test('record() prunes anything older than a day on every write', () => {
  // Measured: a 25h-old entry is gone from the file after one write, a 2h-old one stays.
  writeLedger([
    { ts: NOW - 25 * HOUR, usd: 9, what: 'old' },
    { ts: NOW - 2 * HOUR, usd: 1, what: 'recent' },
  ]);
  ledger.record(0.5, 'new', NOW);
  const entries = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).entries;
  assert.deepStrictEqual(entries.map((e) => e.what), ['recent', 'new']);
  assert.strictEqual(ledger.totals(NOW).dayUsd, 1.5);
});

test('record() writes through a temp file and leaves no stray tmp behind', () => {
  writeLedger([]);
  ledger.record(1, 'x', NOW);
  const stray = fs.readdirSync(TMP).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(stray, [], 'the rename must clean up after itself');
});

// ── totals(): the hour and day windows ─────────────────────────────────────────

test('an entry counts in the hour window only inside it', () => {
  writeLedger([{ ts: NOW - 30 * 60 * 1000, usd: 2, what: 'inside the hour' }]);
  assert.strictEqual(ledger.totals(NOW).hourUsd, 2);
  assert.strictEqual(ledger.totals(NOW).dayUsd, 2);
});

test('an entry outside the hour still counts against the day', () => {
  writeLedger([{ ts: NOW - 5 * HOUR, usd: 3, what: 'five hours ago' }]);
  assert.strictEqual(ledger.totals(NOW).hourUsd, 0);
  assert.strictEqual(ledger.totals(NOW).dayUsd, 3);
});

test('an entry older than a day counts against nothing', () => {
  writeLedger([{ ts: NOW - 25 * HOUR, usd: 9, what: 'yesterday' }]);
  assert.deepStrictEqual(ledger.totals(NOW), { hourUsd: 0, dayUsd: 0 });
});

test('a missing ledger file is zero spend, not an error', () => {
  fs.rmSync(LEDGER, { force: true });
  assert.deepStrictEqual(ledger.totals(NOW), { hourUsd: 0, dayUsd: 0 });
});

test('entries that are not well formed are ignored rather than counted as NaN', () => {
  // read() filters on Number.isFinite for both fields, so a half-written entry cannot
  // poison the total.
  writeLedger([{ ts: NOW, usd: 1 }, null, { what: 'no ts' }, { ts: 'x', usd: 2 }, 'junk']);
  assert.strictEqual(ledger.totals(NOW).hourUsd, 1);
});

// ── check(): the gate ─────────────────────────────────────────────────────────

test('check() passes when both totals are under the cap', () => {
  writeLedger([{ ts: NOW - 60 * 1000, usd: 0.5, what: 'x' }]);
  const r = ledger.check(NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hourUsd, 0.5);
});

test('check() refuses once the hourly cap is reached and says which cap', () => {
  writeLedger([{ ts: NOW - 60 * 1000, usd: 2.5, what: 'x' }]);
  const r = ledger.check(NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /budget_exhausted/);
  assert.match(r.error, /hourly cap/);
  assert.match(r.error, /\$2\.5000/, 'the error must state the amount actually spent');
});

test('the DAILY cap fires on its own, with the hour still under', () => {
  // Eight $1.50 searches spread 2.5h apart: $1.50 in the hour, $12 in the day.
  // MEASURED: refused with the daily-cap message.
  writeLedger(Array.from({ length: 8 }, (_, i) => ({ ts: NOW - i * 2.5 * HOUR, usd: 1.5, what: 'x' })));
  const r = ledger.check(NOW);
  assert.strictEqual(r.hourUsd, 1.5);
  assert.strictEqual(r.dayUsd, 12);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /daily cap/);
});

test('the cap is read per call, so a lowered cap takes effect without a restart', () => {
  writeLedger([{ ts: NOW - 60 * 1000, usd: 0.5, what: 'x' }]);
  assert.strictEqual(ledger.check(NOW).ok, true);
  const prev = process.env.PAID_SPEND_HOUR_USD;
  try {
    process.env.PAID_SPEND_HOUR_USD = '0.25';
    assert.strictEqual(ledger.check(NOW).ok, false);
  } finally {
    if (prev === undefined) delete process.env.PAID_SPEND_HOUR_USD;
    else process.env.PAID_SPEND_HOUR_USD = prev;
  }
});

// ── known weaknesses, pinned so they are not mistaken for guarantees ───────────

test('WEAKNESS: a corrupt ledger file silently reads as zero spend', () => {
  // MEASURED: { ok: true, hourUsd: 0, dayUsd: 0 }. record() writes atomically through
  // a temp file, so this should not happen on its own — but the module's own header
  // says "a cap that resets with the process is no cap", and a truncated file resets
  // the cap just as thoroughly. Asserted so the behaviour is on the record, not
  // because it is desirable.
  fs.writeFileSync(LEDGER, '{not json');
  assert.deepStrictEqual(ledger.totals(NOW), { hourUsd: 0, dayUsd: 0 });
  assert.strictEqual(ledger.check(NOW).ok, true);
});

test('WEAKNESS: a negative entry written by something else switches the cap off', () => {
  // MEASURED: totals -100, check ok:true. record() cannot produce this — it refuses
  // non-positive amounts — so it needs a hand-edited or foreign-written file. Pinned
  // as measured, not as a defect claim.
  writeLedger([{ ts: NOW, usd: -100, what: 'injected' }]);
  assert.strictEqual(ledger.totals(NOW).hourUsd, -100);
  assert.strictEqual(ledger.check(NOW).ok, true);
});