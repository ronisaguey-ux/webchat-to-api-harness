// Regression guard for src/runtime/lane_verdict.js.
//
// The bug this module exists to prevent: the retry gate matched a regex on the error string,
// and a stall's own wording ("no new output") did not contain "Timed out", so the retry was
// unreachable for the exact failure it was written for. These cases pin the CLASS, not the
// sentence, so a reworded error still lands in the right bucket.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/runtime/lane_verdict');

const ERR_CASES = [
    ['Webchat stalled: no new output for 120s - aborting so the caller can retry', 'transient'],
    ['Timed out after 330000ms waiting for a response', 'transient'],
    ['Webchat response is empty after 240s - no new message row appeared', 'transient'],
    ['Target closed', 'transient'],
    ['Protocol error (Runtime.callFunctionOn): Session closed', 'transient'],
    ['fetch failed', 'error'],
    ['Webchat rate limit: Messages too frequent. Try again later.', 'rate'],
    ['rate_limit_reached', 'rate'],
    ['Sign in to continue', 'auth'],
    ['Just a moment...', 'blocked'],
    ['checking your browser before accessing', 'blocked'],
    ['the prompt is too large', 'input'],
    ['context length exceeded', 'context'],
    ['old_string not found (context changed)', 'error'],
    ['', 'error'],
];

test('every failure classifies by meaning, not by one sentence', () => {
    for (const [msg, want] of ERR_CASES) {
        const got = V.classifyError(msg ? new Error(msg) : null);
        assert.equal(got, want, `${JSON.stringify(msg.slice(0, 50))} -> ${got}, expected ${want}`);
    }
});

test('the stall wording that broke the old gate is retryable', () => {
    // The exact regression. It must not depend on the words "Timed out" being present.
    assert.equal(
        V.classifyError(new Error('Webchat stalled: no new output for 120s')),
        'transient'
    );
    assert.equal(V.isRetryable(V.classifyError(new Error('Webchat stalled: no new output for 120s'))), true);
});

test('only a transient fault is resent', () => {
    assert.equal(V.isRetryable('transient'), true);
    for (const c of ['rate', 'auth', 'blocked', 'input', 'context', 'empty', 'error', 'ok']) {
        assert.equal(V.isRetryable(c), false, `${c} must not be resent`);
    }
});

test('only a throttle cools the lane', () => {
    // A lane that is merely BUSY is not failing; cooling it parked a healthy lane for 36 minutes.
    assert.equal(V.coolsLane('rate'), true);
    for (const c of ['transient', 'auth', 'blocked', 'input', 'context', 'empty', 'error', 'ok']) {
        assert.equal(V.coolsLane(c), false, `${c} must not cool the lane`);
    }
});

test('a browser.js retryable tag wins over the message', () => {
    // browser.js saw the failure happen; this module only sees the sentence it wrote.
    const e = new Error('something we do not recognise');
    e.retryable = true;
    assert.equal(V.classifyError(e), 'transient');
});

test('a reply that came back is judged separately from an error', () => {
    assert.equal(V.classifyReply('{"edits":[]}'), 'ok');
    assert.equal(V.classifyReply(''), 'empty');
    assert.equal(V.classifyReply('   '), 'empty');
    assert.equal(V.classifyReply('Messages too frequent. Try again later.'), 'rate');
    assert.equal(V.classifyReply('Sign in to continue'), 'auth');
});

test('describe never separates a class from its cause', () => {
    assert.match(V.describe('transient', new Error('stalled for 120s')), /^transient: stalled/);
    assert.equal(V.describe('error', null), 'error');
});
