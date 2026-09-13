'use strict';

// ── Webchat rate-limit detector + cooldown ──────────────────────────────────
// A webchat account throttles us for sending too fast and answers with
//   "Messages too frequent. Try again later."  (DeepSeek, finish_reason
//   rate_limit / rate_limit_reached)
// The harness used to treat that as a normal (empty) reply, so the caller
// retried straight away, got throttled again, and burned its whole round
// budget on a lane that could not answer.
//
// This module turns it into an explicit, shared cooldown:
//   - detect the throttle text in a reply (or a thrown send error),
//   - put that webchat on a flat cooldown (default 15 min),
//   - answer 429 + Retry-After immediately while the cooldown is in force,
//     so a caller fails fast and can move to another lane instead of hanging.
//
// Config (harness.config.json → features.rateLimitCooldownSeconds, or env):
//   RATE_LIMIT_COOLDOWN_S   seconds to cool a throttled webchat (default 900)
//   RATE_LIMIT_GUARD=false  disable the detector entirely
//
// The cooldown is per ACCOUNT (the lock key the gateway already uses), so the
// three DeepSeek accounts never cool each other.

const fs = require('fs');
const path = require('path');

const COOLDOWN_S = Number(process.env.RATE_LIMIT_COOLDOWN_S
    || process.env.WEBCHAT_RATE_LIMIT_COOLDOWN_S
    || 900);

// The phrasings the sites use. Every one is a THROTTLE NOTICE, not a phrase
// that can appear in a real answer. Measured false positive: a loose
// /rate\s*limit/i matched "Here is the rate limiting middleware I wrote for
// you..." — a normal reply about rate limiting. Never match a bare
// "rate limit"; require the notice's own words.
const PATTERNS = [
    /messages?\s+too\s+frequent/i,
    /too\s+many\s+requests/i,
    /rate[_ ]?limit[_ ]?(?:reached|exceeded|error)/i,
    /finish_reason["\s:]+rate_limit/i,
    /free_rate_limited/i,
    /你发送消息的频率过快/,
    /发送太频繁/,
];

// A reply that is ONLY the throttle notice: short, and the notice appears in the
// opening of the text (a real answer that quotes the phrase would have it deep
// in the body, after real content).
function isRateLimitText(text) {
    if (!text) return false;
    const t = String(text).trim();
    if (!t) return false;
    if (t.length > 300) return false;
    const head = t.slice(0, 160);
    return PATTERNS.some((re) => re.test(head));
}

function isRateLimitError(err) {
    const m = (err && (err.message || err.error || String(err))) || '';
    return isRateLimitText(m);
}

// Cooldown store. One JSON file per account so the three DeepSeek gateways do
// not need to share memory, and a restart does not forget a live throttle.
function storePath(account) {
    const dir = process.env.RATE_LIMIT_STATE_DIR || '/tmp';
    const key = String(account || process.env.WEBCHAT_ACCOUNT || process.env.PORT || 'default')
        .replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(dir, `.webchat_ratelimit_${key}.json`);
}

function readUntil(account) {
    try {
        const raw = fs.readFileSync(storePath(account), 'utf-8').trim();
        if (!raw) return 0;
        const d = JSON.parse(raw);
        return Number(d.until) || 0;
    } catch {
        return 0;
    }
}

function writeUntil(account, until) {
    try {
        const p = storePath(account);
        const tmp = `${p}.tmp${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify({ until, ts: Date.now() }));
        fs.renameSync(tmp, p);
    } catch { /* a cooldown we cannot persist still applies in-process */ }
}

let memoryUntil = 0;

function remainingMs(account) {
    const until = Math.max(memoryUntil, readUntil(account));
    return Math.max(0, until - Date.now());
}

function startCooldown(account, seconds) {
    const s = Number(seconds) > 0 ? Number(seconds) : COOLDOWN_S;
    const until = Date.now() + s * 1000;
    memoryUntil = until;
    writeUntil(account, until);
    return { until, seconds: s };
}

function clearCooldown(account) {
    memoryUntil = 0;
    writeUntil(account, 0);
}

const enabled = () => String(process.env.RATE_LIMIT_GUARD || 'true').toLowerCase() !== 'false';

module.exports = {
    enabled,
    isRateLimitText,
    isRateLimitError,
    remainingMs,
    startCooldown,
    clearCooldown,
    cooldownSeconds: () => COOLDOWN_S,
};
