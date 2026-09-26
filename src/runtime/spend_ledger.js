'use strict';
//
// spend_ledger.js — a persisted record of what paid calls cost, with hard caps.
//
// search_web makes a paid DeepSeek request per call, and nothing bounded how many: the
// anti-spiral loop limits ROUNDS, not paid calls, and a model that loops on search runs
// up the bill with no ceiling. The owner's rule is $2/hour and $10/day. This ledger is
// a file (not memory) because the gateway restarts, several lane gateways share one
// key, and a cap that resets with the process is no cap.
//
// Entries older than a day are dropped on every write, so the file stays small.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

function ledgerFile() {
    if (process.env.SPEND_LEDGER_FILE) return path.resolve(process.env.SPEND_LEDGER_FILE);
    const dir = process.env.RATE_LIMIT_STATE_DIR || os.tmpdir();
    return path.join(dir, '.webchat_paid_spend.json');
}

function caps() {
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
    return {
        hourUsd: num(process.env.PAID_SPEND_HOUR_USD, 2),
        dayUsd: num(process.env.PAID_SPEND_DAY_USD, 10),
    };
}

function read() {
    try {
        const d = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
        return Array.isArray(d.entries) ? d.entries.filter((e) => e && Number.isFinite(e.ts) && Number.isFinite(e.usd)) : [];
    } catch { return []; }
}

function totals(now = Date.now()) {
    const entries = read();
    let hour = 0; let day = 0;
    for (const e of entries) {
        if (now - e.ts < DAY_MS) day += e.usd;
        if (now - e.ts < HOUR_MS) hour += e.usd;
    }
    return { hourUsd: hour, dayUsd: day };
}

// { ok: true } or { ok: false, error } when either cap is already reached.
function check(now = Date.now()) {
    const t = totals(now);
    const c = caps();
    if (t.hourUsd >= c.hourUsd) {
        return { ok: false, ...t, error: `budget_exhausted: paid spend $${t.hourUsd.toFixed(4)} in the last hour has reached the $${c.hourUsd} hourly cap` };
    }
    if (t.dayUsd >= c.dayUsd) {
        return { ok: false, ...t, error: `budget_exhausted: paid spend $${t.dayUsd.toFixed(4)} in the last 24h has reached the $${c.dayUsd} daily cap` };
    }
    return { ok: true, ...t };
}

function record(usd, what = '', now = Date.now()) {
    const v = Number(usd);
    if (!Number.isFinite(v) || v <= 0) return;
    const entries = read().filter((e) => now - e.ts < DAY_MS);
    entries.push({ ts: now, usd: v, what: String(what).slice(0, 40) });
    const file = ledgerFile();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ entries }));
        fs.renameSync(tmp, file);
    } catch (e) {
        console.warn('⚠️ spend ledger write failed:', e.message);
    }
}

module.exports = { ledgerFile, caps, totals, check, record };
