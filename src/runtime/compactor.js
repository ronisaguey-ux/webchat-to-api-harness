'use strict';
//
// compactor.js — tool-result compaction for the harness, ported from the owner's
// tool-call-compactor (/home/roni/Roni_workspace/tool-call-compactor, src/compress.js).
//
// The harness cannot import that module: it is ESM, carries the MCP SDK, and the
// harness has a hard "no new dependency, no build step" rule. So the two rules that
// actually matter for tool output are re-implemented here, line-for-line faithful
// where possible:
//
//   1. NEVER touch an error result. A truncated stack trace is a wrong answer.
//   2. NEVER drop the tail. The model's question is answered by what comes first,
//      but the tail is where the interesting line often is — so truncate to
//      head + tail with an explicit marker, never head-only.
//
// The compactor runs on the harness's own result shape (plain objects with string
// and array fields, `success` flag), not on the MCP {content:[...]} envelope, so it
// slots into server.js's tool-result path without an adapter.
//
// The DEFAULT_LIMITS mirror the owner's tool-call-compactor src/compress.js so the
// two never disagree about what "compacted" means.

const DEFAULT_LIMITS = {
    maxText: 10000,   // chars in a single text field before head+tail truncation
    maxItems: 10,     // array items kept from a long list
    headItems: 3,
    tailItems: 2,
};

// Text fields that hold the bulk of tool output. Names are the harness's own
// (stdout/stderr/content/answer) plus the generic MCP-ish ones the compactor
// already understands, so a result from any source is treated the same.
const TEXT_FIELDS = new Set([
    'content', 'stdout', 'stderr', 'answer', 'text', 'message', 'branchStatus',
    'recentCommits', 'summary',
]);
const ARRAY_FIELDS = new Set(['results', 'files', 'items', 'entries']);

// Head 60% + tail 40%, with a marker naming how much was dropped — the exact
// shape the owner's compactor emits, so nobody reading a receipt can miss that
// the middle is gone.
function truncateText(text, maxText) {
    const s = String(text ?? '');
    if (s.length <= maxText) return s;
    const head = Math.floor(maxText * 0.6);
    const tail = maxText - head;
    const dropped = s.length - maxText;
    return `${s.slice(0, head)}\n… [tool-result compacted: ${dropped.toLocaleString('en-US')} characters dropped] …\n${s.slice(-tail)}`;
}

function clipArray(arr, { maxItems, headItems, tailItems }) {
    if (arr.length <= maxItems) return { out: arr, changed: false };
    const head = arr.slice(0, headItems);
    const tail = arr.slice(-tailItems);
    const dropped = arr.length - head.length - tail.length;
    const marker = `… [tool-result compacted: ${dropped} of ${arr.length} items dropped] …`;
    return { out: [...head, marker, ...tail], changed: true };
}

function clipTextFields(obj, maxText) {
    let changed = false;
    const out = { ...obj };
    for (const key of Object.keys(out)) {
        const v = out[key];
        if (typeof v === 'string' && v.length > maxText) {
            out[key] = truncateText(v, maxText);
            changed = true;
        }
    }
    return { out, changed };
}

function clipArrayFields(obj, limits) {
    let changed = false;
    const out = { ...obj };
    for (const key of Object.keys(out)) {
        const v = out[key];
        if (Array.isArray(v) && v.length > limits.maxItems) {
            const r = clipArray(v, limits);
            if (r.changed) { out[key] = r.out; changed = true; }
        }
    }
    return { out, changed };
}

// The single entry point the tool loop calls. `limits` overrides the defaults so
// the config can tune it. Returns the (possibly) compacted result and a
// `compacted` flag, matching the owner's compressResult contract.
function compactResult(result, limits = {}) {
    const opts = { ...DEFAULT_LIMITS, ...(limits || {}) };
    if (!result || typeof result !== 'object') return { result, compacted: false };
    // Rule 1: an error is sacred. Never rewrite it.
    if (result.success === false || result.error || result.isError) {
        return { result, compacted: false };
    }
    const byText = clipTextFields(result, opts.maxText);
    const byArray = clipArrayFields(byText.out, opts);
    const compacted = byText.changed || byArray.changed;
    if (!compacted) return { result, compacted: false };
    return { result: byArray.out, compacted: true };
}

// Trim a single plain string (a receipt the harness already rendered) with the
// same head+tail rule, used when the compactor runs on the final receipt text
// rather than the raw result object.
function truncateReceipt(text, maxText) {
    return truncateText(text, maxText);
}

module.exports = { compactResult, truncateText, truncateReceipt, DEFAULT_LIMITS };
