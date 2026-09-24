'use strict';
//
// A transient upstream overload must be RETRYABLE; a throttle must NOT be.
//
// Measured failure this guards: a 75-tool-call plan run died with HTTP 500 on
//   "DeepSeek stream error: Server busy, please try again later. (finish_reason:
//    generation_timeout) — wait ~30s and retry"
// The send gate in server.js resends only when `e.retryable` is set, and that message
// matched none of its patterns, so a condition a single resend survives killed the job.
//
// The collision that makes this non-trivial: a throttle reads "Try again later" too,
// so a naive transient pattern would mark it retryable and the resend would hammer the
// same account instead of entering the cooldown path.
//
const test = require('node:test');
const assert = require('node:assert');

// browser.js requires puppeteer at module load; stub it rather than skipping the test.
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'puppeteer') return { launch: async () => ({}) };
    return origRequire.apply(this, arguments);
};
const B = require('../browser.js');

test('a transient upstream overload is tagged retryable', () => {
    const e = B.streamError('Server busy, please try again later. (finish_reason: generation_timeout)');
    assert.strictEqual(e.retryable, true);
    assert.strictEqual(e.streamError, true);
    assert.strictEqual(e.rateLimited, undefined);
});

test('a throttle is NOT retryable, and is marked rate-limited', () => {
    for (const t of ['Messages too frequent. Try again later.', 'rate_limit_reached']) {
        const e = B.streamError(t);
        assert.strictEqual(e.retryable, undefined, `must not resend: ${t}`);
        assert.strictEqual(e.rateLimited, true, `must enter the cooldown path: ${t}`);
    }
});

test('the throttle check wins over the transient pattern that also matches it', () => {
    // "Try again later" is in BOTH vocabularies. Order is the whole fix.
    const e = B.streamError('Too many requests. Try again later.');
    assert.strictEqual(e.rateLimited, true);
    assert.notStrictEqual(e.retryable, true);
});

test('other transient wording is retryable', () => {
    for (const t of ['The model is overloaded right now', '503 Service Unavailable']) {
        assert.strictEqual(B.streamError(t).retryable, true, t);
    }
});

test('unrecognised stream noise is neither', () => {
    const e = B.streamError('some unrelated stream garbage');
    assert.strictEqual(e.retryable, undefined);
    assert.strictEqual(e.rateLimited, undefined);
});

test('the message still carries the original text, so logs stay diagnosable', () => {
    const e = B.streamError('Server busy');
    assert.match(e.message, /Server busy/);
    assert.match(e.message, /DeepSeek stream error/);
});
