/**
 * Class-based lane verdicts.
 *
 * Ported from api-anything's src/classify.ts (MIT, goodnight000/api-anything). The idea taken
 * from it is the one the harness was missing: a failure is judged by what it MEANS, once, in a
 * single place, instead of by a regex on the error string at the retry site.
 *
 * Why this exists. The send gate used to test `/Timed out/` alone. A stall throws
 * "Webchat stalled: no new output for 120s ..." — no "Timed out" in it — so the retry was
 * UNREACHABLE for the exact failure it was written for. It ran that way for weeks and cost a
 * full engine budget per stall until someone read the strings. Wording is not a contract; a
 * class is. When a site rephrases its error the CLASS stays right, and only the patterns here
 * need touching.
 *
 * Scope. This judges an already-failed call, or a reply that came back but is unusable. It does
 * not talk to the browser and it does not retry — it returns a verdict and the caller decides.
 */

'use strict';

/**
 * @typedef {'ok'|'empty'|'transient'|'rate'|'auth'|'blocked'|'context'|'drift'|'input'|'error'} LaneClass
 */

/**
 * Rate limiting. Deliberately separate from `transient`: a throttle must COOLDOWN, and
 * resending it deepens the limit (the harness already has a 900s account cooldown for it).
 * Words taken from what these sites actually render, not invented.
 */
const RATE = [
    /messages? too frequent/i,
    /rate.?limit(ed|_reached)?/i,
    /too many requests/i,
    /try again later/i,
    /please wait (a few )?(minutes|seconds)/i,
    /slow down/i,
];

/**
 * The session is gone. A webchat that has been signed out answers with the marketing page or
 * a soft prompt rather than an error, so this also matches the sign-in copy those pages carry.
 */
const AUTH = [
    /not logged in/i,
    /(sign|log) ?in to continue/i,
    /please (sign|log) ?in/i,
    /invalid session/i,
    /session (has )?expired/i,
    /authentication (required|failed)/i,
    /unauthorized/i,
];

/**
 * A bot wall. Reached from the page text the gateway already collects, so it is cheap.
 * Cloudflare is on this list because it is the one we have actually hit (chatgpt on a
 * headless browser returns "Just a moment..." with a 403 and an empty body).
 */
const BLOCKED = [
    /just a moment/i,
    /attention required/i,
    /checking your browser/i,
    /verify you are (a )?human/i,
    /prove your humanity/i,
    /enable javascript and cookies/i,
    /cf-chl-|challenges\.cloudflare\.com/i,
    /access denied/i,
];

/**
 * The thread is too long for the tab. The webchat starts answering the wrong question, or
 * stops answering at all, once its conversation grows past what it will hold.
 */
const CONTEXT = [
    /context (length|limit|window)/i,
    /conversation (is )?too long/i,
    /maximum context/i,
    /message too (large|long)/i,
    /token limit/i,
];

/** A request the site refused because we asked it wrong — retrying this identical call is waste. */
const INPUT = [
    /prompt (is )?too large/i,
    /request (entity )?too large/i,
    /invalid (request|parameter|argument)/i,
    /unsupported (media|format)/i,
    /413/,
];

/**
 * A hung or dropped send, and a transient upstream fault. These are the ones worth retrying:
 * nothing about the request was wrong, the call simply did not complete.
 *
 * `stalled: no new output` is listed by its CLASS (a stall) not by one site's sentence — the
 * point of this module. Any future stall message that carries the word stall is covered.
 */
const TRANSIENT = [
    /timed? ?out/i,
    /stalled/i,
    /no new (message )?row appeared/i,
    /no new output/i,
    /\bdisconnect/i,
    /econnreset|econnrefused|etimedout|epipe|socket hang ?up/i,
    /requesting main frame too early/i,
    /target closed|session closed|detached frame|execution context was destroyed/i,
    /reconnect/i,
    /server busy|generation_timeout|overloaded|temporarily unavailable/i,
    /\b50[0-4]\b/,
    /network error/i,
];

/** The reply arrived and is not an answer: it streamed nothing, or nothing usable. */
const EMPTYISH = [
    /response is empty/i,
    /empty (assistant|response|answer)/i,
    /no edits? (was |were )?(emitted|produced|proposed)/i,
];

const test = (pats, s) => pats.find((p) => p.test(s));

/**
 * Classify a failure.
 *
 * Order matters and is deliberate:
 *   rate before transient — a throttle that also reads as "try again later" must cool, not retry
 *   auth before blocked — a sign-in page is not a bot wall
 *   input before transient — a too-large prompt will be too large on the retry too
 *   transient before empty — a stall that produced no text is a stall, and is retryable
 *
 * @param {{message?: string, name?: string, retryable?: boolean, httpStatus?: number}} err
 * @returns {LaneClass}
 */
function classifyError(err) {
    if (!err) return 'error';
    // A caller that already knows (browser.js tags its own stalls) wins: it saw the failure
    // happen, and this module only sees the sentence it wrote.
    if (err.retryable === true) return 'transient';

    const s = String(err.message || err || '');
    if (!s) return 'error';
    if (test(RATE, s)) return 'rate';
    if (test(AUTH, s)) return 'auth';
    if (test(BLOCKED, s)) return 'blocked';
    if (test(INPUT, s)) return 'input';
    if (test(TRANSIENT, s)) return 'transient';
    if (test(EMPTYISH, s)) return 'empty';
    if (test(CONTEXT, s)) return 'context';
    return 'error';
}

/**
 * Classify a reply that came back without throwing.
 *
 * The harness has been bitten on both sides of this: a reply judged "empty" while the tab held a
 * complete answer (a reader bug), and a reply accepted while it was really a rate-limit notice.
 *
 * @param {string} text the assistant text the gateway extracted
 * @param {{sawContent?: boolean}} [meta]
 * @returns {LaneClass}
 */
function classifyReply(text, meta = {}) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return meta.sawContent ? 'empty' : 'empty';
    if (test(RATE, s)) return 'rate';
    if (test(AUTH, s)) return 'auth';
    if (test(BLOCKED, s)) return 'blocked';
    if (test(CONTEXT, s)) return 'context';
    return 'ok';
}

/**
 * Is this class worth sending again?
 *
 * Only a TRANSIENT fault is: the request was fine and the wire dropped it. Everything else is
 * either a decision the site already made (rate, auth, blocked, input, context) or a caller
 * problem. Retrying those spends the site's patience and our budget to reach the same wall —
 * which is what happened before this module existed.
 */
function isRetryable(cls) {
    return cls === 'transient';
}

/**
 * The other class that must never climb the cooldown ladder. A lane that is merely BUSY is not
 * failing, and the engine has already measured what happens when it is treated as though it
 * were: an escalating streak parked a healthy lane for up to 36 minutes.
 */
function coolsLane(cls) {
    return cls === 'rate';
}

/** A one-line human summary for a log, so the class is never separated from its cause. */
function describe(cls, err) {
    const s = String((err && (err.message || err)) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return s ? `${cls}: ${s}` : cls;
}

module.exports = {
    classifyError,
    classifyReply,
    isRetryable,
    coolsLane,
    describe,
    // exported for tests
    patterns: { RATE, AUTH, BLOCKED, CONTEXT, INPUT, TRANSIENT, EMPTYISH },
};
