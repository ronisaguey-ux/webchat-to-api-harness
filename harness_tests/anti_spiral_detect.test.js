'use strict';
// Unit layer for src/runtime/anti_spiral.js.
//
// WHY THIS FILE EXISTS. `grep -l anti_spiral harness_tests/*` returned nothing: the
// loop-breaker had no test at all. It gates the round budget — when the detector
// misses, the tab is fed until the budget runs out and the caller gets "did not
// submit a final answer within the round budget" with all the work lost; when it
// false-positives, a legitimate answer is truncated and the model is told to stop.
//
// The module is pure and exports its own functions, so the whole surface is cheap to
// pin. The thresholds in here were raised on 2026-09-13 after a measured false
// positive (twelve DIFFERENT lines sharing a template scored 0.38 on a 5-gram), so
// the "must NOT fire" cases are as important as the "must fire" ones and are given
// their own tests.
//
// Every input below was run against the module before being written down; the
// comments record the MEASURED result, not the intended one.

const test = require('node:test');
const assert = require('node:assert');
const spiral = require('../src/runtime/anti_spiral');

// ~24 words, comfortably over MIN_WORDS (40) once a case is appended.
const FILLER = 'The build fails because the linker cannot find the shared object. '
    + 'We checked the runtime path and the compiler flags and nothing explains it. ';

const PROSE_LINE = 'I inspected the module and applied the fix to the failing branch';
const SHORT_SENTENCE = 'The linker cannot find it at runtime.'; // 36 chars
const LONG_SENTENCE = 'The linker cannot find the shared object that the binary needs at runtime.';

// ── the master switch ─────────────────────────────────────────────────────────

test('enabled() is a pure read of ANTI_SPIRAL and defaults to off', () => {
  const prev = process.env.ANTI_SPIRAL;
  delete process.env.ANTI_SPIRAL;
  assert.strictEqual(spiral.enabled(), false);
  for (const [v, want] of [['true', true], ['TRUE', true], ['1', false], ['yes', false], ['false', false]]) {
    process.env.ANTI_SPIRAL = v;
    assert.strictEqual(spiral.enabled(), want, `ANTI_SPIRAL=${v}`);
  }
  if (prev === undefined) delete process.env.ANTI_SPIRAL; else process.env.ANTI_SPIRAL = prev;
});

// ── short and empty input is never judged ─────────────────────────────────────

test('text below MIN_WORDS (40) is not judged', () => {
  // 15 words — under the bar, so even a blatant tic is left alone.
  assert.strictEqual(spiral.detectSpiral('Let me go.\n'.repeat(5)), null);
  assert.strictEqual(spiral.detectSpiral('too short'), null);
});

test('the same tic well over MIN_WORDS IS judged', () => {
  // The control for the test above: 150 words of the same tic, kind 'tic', count 50.
  const r = spiral.detectSpiral('Let me go.\n'.repeat(50));
  assert.ok(r, 'expected evidence');
  assert.strictEqual(r.kind, 'tic');
  assert.strictEqual(r.count, 50);
});

test('empty and missing input returns null rather than throwing', () => {
  for (const v of ['', null, undefined, 0]) {
    assert.strictEqual(spiral.detectSpiral(v), null, String(v));
  }
});

// ── signature 1: the same sentence twice in a row ─────────────────────────────

test('the same long sentence twice in a row is a spiral', () => {
  const r = spiral.detectSpiral(FILLER + LONG_SENTENCE + ' ' + LONG_SENTENCE);
  assert.ok(r, 'expected evidence');
  assert.strictEqual(r.kind, 'sentence');
  assert.strictEqual(r.count, 2);
  assert.match(r.phrase, /linker cannot find/);
});

test('a sentence at or under the 30-char bar is not a sentence-loop', () => {
  // MEASURED: null. Without this the detector would fire on every "Yes, that works."
  // the model repeats while thinking.
  assert.strictEqual(spiral.detectSpiral(FILLER + SHORT_SENTENCE + ' ' + SHORT_SENTENCE), null);
});

test('narration raises the sentence bar from 30 to 60 chars', () => {
  // A 56-char sentence repeated twice straddles the two thresholds: over the 30-char
  // bar that applies with narration OFF, under the 60-char bar that applies with it on.
  const mid = 'The linker cannot find the shared object at runtime now.';
  assert.strictEqual(mid.length, 56, 'the fixture must stay between 30 and 60 chars');
  assert.ok(spiral.detectSpiral(FILLER + mid + ' ' + mid), '56 > 30 must fire with narration off');
  assert.strictEqual(
    spiral.detectSpiral(FILLER + mid + ' ' + mid, { narration: true }),
    null, '56 <= 60 must NOT fire with narration on');
});

// ── signature 2: the same prose line three or more times ──────────────────────
//
// NOTE ON THE FIXTURE: FILLER has to end in a newline. The detector splits the raw
// text into physical lines, so without it the first copy of PROSE_LINE is glued to the
// end of the filler and only two standalone copies remain — which is not the case
// these tests are about. (Measured: `FILLER + line + '\n' + line + '\n' + line`
// returns null, and the same string with a trailing newline on FILLER returns
// { kind: 'line', count: 3 }.)
const three = FILLER + '\n' + PROSE_LINE + '\n' + PROSE_LINE + '\n' + PROSE_LINE;
const four = three + '\n' + PROSE_LINE;

test('a prose line repeated three times is a spiral', () => {
  const r = spiral.detectSpiral(three);
  assert.ok(r, 'expected evidence');
  assert.strictEqual(r.kind, 'line');
  assert.strictEqual(r.count, 3);
});

test('a prose line repeated twice is not enough', () => {
  assert.strictEqual(spiral.detectSpiral(FILLER + '\n' + PROSE_LINE + '\n' + PROSE_LINE), null);
});

test('narration raises the line threshold from 3 to 4', () => {
  assert.ok(spiral.detectSpiral(three), 'three copies fire with narration off');
  assert.strictEqual(spiral.detectSpiral(three, { narration: true }), null,
    'three copies must not fire with narration on');
  assert.strictEqual(spiral.detectSpiral(four, { narration: true }).count, 4,
    'four copies fire with narration on');
});

// ── signature 3: the stall tic ────────────────────────────────────────────────

test('a short "Let me go." tic repeated is a spiral', () => {
  const raw = FILLER + 'Let me go.\n'.repeat(6);
  const r = spiral.detectSpiral(raw);
  assert.ok(r, 'expected evidence');
  assert.strictEqual(r.kind, 'tic');
  assert.match(r.phrase, /Let me go/);
});

test('narration raises the tic bar from 4 to 10', () => {
  const raw = FILLER + 'Let me go.\n'.repeat(6);
  assert.strictEqual(spiral.detectSpiral(raw).kind, 'tic', 'six copies fire with narration off');
  // MEASURED: with narration on, six copies are STILL caught — but by signature 4
  // (n-gram dominance), not by the tic detector. That is the intended shape: the
  // narration discount applies to the tic bar, and a genuinely degenerate message is
  // still stopped. What must not happen is a *tic* verdict at narration height.
  const on = spiral.detectSpiral(raw, { narration: true });
  assert.notStrictEqual(on.kind, 'tic', 'the tic bar must not fire at 6 copies with narration on');
  assert.strictEqual(spiral.detectSpiral(FILLER + 'Let me go.\n'.repeat(12), { narration: true }).count, 10,
    'twelve copies reach the narration tic bar of 10');
});

test('a tic that carries a digit is not counted', () => {
  // "Step 3." varies in a numbered loop, so it is templating, not a tic. Signature 4
  // excludes digit-bearing grams too, so 10 copies stay clean.
  assert.strictEqual(spiral.detectSpiral(FILLER + 'Step 3.\n'.repeat(10)), null);
});

test('a line with a trailing colon is not counted as a tic', () => {
  // MEASURED: kind 'phrase', count 7 — signature 3 skips it, signature 4 still sees it.
  const r = spiral.detectSpiral(FILLER + 'first thing:\n'.repeat(10));
  assert.notStrictEqual(r && r.kind, 'tic');
});

test('a role-prefixed line is not counted as a tic', () => {
  // MEASURED: kind 'phrase', count 7 — same as above.
  const r = spiral.detectSpiral(FILLER + 'assistant: ok.\n'.repeat(10));
  assert.notStrictEqual(r && r.kind, 'tic');
});

// ── signature 4: n-gram dominance, and the false positive it was tuned against ─

test('twelve DIFFERENT lines sharing a template must NOT be a spiral', () => {
  // The measured false positive of 2026-09-13: the 5-gram scored 0.38 because the
  // fixed words repeat while the numbers change. Digit-bearing grams are excluded.
  const raw = FILLER + Array.from({ length: 12 },
    (_, i) => `Step ${i + 1}: I inspected module ${i + 1} and applied the fix there.`).join(' ');
  assert.strictEqual(spiral.detectSpiral(raw), null);
});

test('the same n-gram with no digits in it IS a spiral', () => {
  const raw = FILLER + 'the quick brown fox jumps over the lazy dog. '.repeat(8);
  const r = spiral.detectSpiral(raw);
  assert.ok(r, 'expected evidence');
  assert.ok(['phrase', 'sentence', 'line'].includes(r.kind), r.kind);
});

// ── signature 5: tail dominance ───────────────────────────────────────────────

test('a degenerate tail of short lines varying only by number is NOT a spiral', () => {
  // MEASURED: null. Signature 5's tail check needs <= 4 distinct lines in the last 12,
  // and these differ by their digit; the n-gram path excludes digit-bearing grams.
  // Recorded so a future threshold change that starts firing here is a visible diff.
  const raw = FILLER + Array.from({ length: 14 }, (_, i) => `line ${i} here`).join('\n');
  assert.strictEqual(spiral.detectSpiral(raw), null);
});

test('a message that degenerates into one repeated line is caught', () => {
  // MEASURED: kind 'line' — signature 2 wins before signature 5 gets a look.
  const raw = FILLER + Array.from({ length: 14 }, () => 'and then it just stops here').join('\n');
  const r = spiral.detectSpiral(raw);
  assert.ok(r, 'expected evidence');
  assert.strictEqual(r.kind, 'line');
  assert.strictEqual(r.count, 3);
});

test('signature 5 (kind "tail") fires once signatures 1-4 are ruled out', () => {
  // Twenty numbered tics: the tic detector rejects them for carrying digits and the
  // n-gram path rejects digit-bearing grams, so the last resort is what catches it.
  // MEASURED (narration on, which is the only way to get past the tic bar of 10):
  // { kind: 'tail', phrase: 'Step 3.', count: 12, coverage: 1 }.
  const r = spiral.detectSpiral(FILLER + 'Step 3.\n'.repeat(20), { narration: true });
  assert.strictEqual(r.kind, 'tail');
  assert.strictEqual(r.phrase, 'Step 3.');
});

// ── narration is not prose ────────────────────────────────────────────────────

test('code fences, tables and lists are stripped before measuring', () => {
  // These repeat legitimately (a tool loop), so a detector that measured them would
  // fire on every tool-using session.
  const raw = FILLER + '```js\nlet x = 1;\n```\n'.repeat(8);
  assert.strictEqual(spiral.detectSpiral(raw), null);
});

test('a markdown table repeated down the message is not a spiral', () => {
  const row = '| a | b | c |';
  assert.strictEqual(spiral.detectSpiral(FILLER + (row + '\n').repeat(14)), null);
});

test('stripNonProse removes fences, inline code and list markers', () => {
  assert.strictEqual(spiral.stripNonProse('a\n```js\nlet x=1;\n```\nb'), 'a\n\n\nb');
  assert.strictEqual(spiral.stripNonProse('a `b` c'), 'a   c');
  assert.strictEqual(spiral.stripNonProse('- one\n- two'), 'one\ntwo');
  assert.strictEqual(spiral.stripNonProse('## head'), 'head');
});

// ── the user-facing strings ───────────────────────────────────────────────────

test('describe() names the evidence, and falls back when there is none', () => {
  assert.strictEqual(spiral.describe({ kind: 'tic', phrase: 'Let me go.', count: 6 }),
    'the stall tic "Let me go." repeated x6');
  assert.strictEqual(spiral.describe({ kind: 'line', phrase: 'x y z', count: 3 }),
    'the same line repeated x3 ("x y z")');
  assert.match(spiral.describe({ kind: 'tail', phrase: 'p', count: 4 }), /end of the message/);
  assert.match(spiral.describe({ kind: 'sentence', phrase: 'p' }), /same sentence twice/);
  assert.match(spiral.describe({ kind: 'phrase', phrase: 'p', count: 9 }), /dominating the message/);
  assert.strictEqual(spiral.describe(null), 'a repeated reasoning loop');
  assert.strictEqual(spiral.describe(undefined), 'a repeated reasoning loop');
});

test('the banner goes at the TOP of the answer and says work may be incomplete', () => {
  const b = spiral.spiralBanner({ kind: 'line', phrase: 'x', count: 3 });
  assert.match(b, /^\u{1F6D1} \[ANTI-SPIRAL\] Generation stopped: /u);
  assert.match(b, /may be incomplete/);
  assert.match(b, /\n\n$/, 'banner must be followed by a blank line so text starts after it');
});

test('the redirect asks for exactly one fenced tool call and no prose', () => {
  const r = spiral.spiralRedirect(null);
  assert.match(r, /^STOP\. You are stuck in a loop/);
  assert.match(r, /```json/);
  assert.match(r, /submit_answer/);
  assert.match(r, /No prose outside the JSON/);
});

test('the banner and the redirect both carry the evidence, not just the fallback', () => {
  const ev = { kind: 'tic', phrase: 'Let me go.', count: 6 };
  assert.match(spiral.spiralBanner(ev), /Let me go/);
  assert.match(spiral.spiralRedirect(ev), /Let me go/);
});

test('the evidence phrase is truncated so the banner cannot be flooded', () => {
  const ev = { kind: 'line', phrase: 'w '.repeat(400), count: 3 };
  assert.ok(spiral.spiralBanner(ev).length < 400, 'banner must stay bounded');
});