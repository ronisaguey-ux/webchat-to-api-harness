'use strict';
//
// The reported defect: Claude Code against /v1/messages gets "API Error: Server error
// mid-response" instead of a usable result when the gateway fails mid-turn.
//
// The bug is the SHAPE of what the client receives, not the error. A stream that ends
// with `event: error` and nothing else leaves the open content block dangling and the
// message unterminated, so the client cannot tell a finished turn from a cut cable.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-sse-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');

const { __test } = require(path.join(__dirname, '..', 'server.js'));
const { streamFailureEvents } = __test;

test('a failed stream still terminates the message', () => {
    const frames = streamFailureEvents({ partial: '', openBlock: -1, message: 'boom' });
    const events = frames.map((f) => f.event);
    // These two are what the client reads as "the turn is over". Without them it
    // reports a server error mid-response and cannot continue cleanly.
    assert.ok(events.includes('message_stop'), 'the stream must end with message_stop');
    assert.ok(events.includes('message_delta'), 'and announce the stop reason before it');
    const delta = frames.find((f) => f.event === 'message_delta');
    assert.strictEqual(delta.data.delta.stop_reason, 'error', 'a failure must not report end_turn');
});

test('the error itself is still delivered', () => {
    const frames = streamFailureEvents({ message: 'round budget exhausted' });
    const err = frames.find((f) => f.event === 'error');
    assert.ok(err, 'the client must be told what went wrong');
    assert.strictEqual(err.data.error.message, 'round budget exhausted');
});

test('every content block it opens, it closes', () => {
    // The block being closed here was opened BEFORE the failure, by the loop — so a
    // stop with no matching start in these frames is the correct shape, not a leak.
    // The invariant is: stops === starts + (one for the block the loop left open).
    const withOpen = streamFailureEvents({ openBlock: 3, message: 'x' });
    let starts = 0;
    let stops = 0;
    for (const f of withOpen) {
        if (f.event === 'content_block_start') starts++;
        if (f.event === 'content_block_stop') stops++;
    }
    assert.strictEqual(starts, 0, 'the failure path opens no new text block');
    assert.strictEqual(stops, 1, 'it closes the block the loop left open — a dangling block is what the client chokes on');

    // With nothing left open, it must close nothing.
    const clean = streamFailureEvents({ openBlock: -1, message: 'x' });
    assert.strictEqual(clean.filter((f) => f.event === 'content_block_stop').length, 0);
});

test('the failure path NEVER re-sends text the client already has', () => {
    // The reported symptom "tool calls/receipts are rendered TWICE in the Claude Code
    // terminal" is this: the partial answer was already streamed as deltas in blocks
    // that were already stopped, so re-emitting it duplicates the whole reply on the
    // client. The fix is to send the END of the message and nothing else.
    const frames = streamFailureEvents({ partial: 'I read three files and', openBlock: 2, message: 'timeout' });
    const text = frames
        .filter((f) => f.event === 'content_block_delta')
        .map((f) => f.data.delta.text)
        .join('');
    assert.strictEqual(text, '', 'no delta may carry text the client has already been sent');
});

test('the partial count is still reported in usage', () => {
    const frames = streamFailureEvents({ partial: 'abcde' });
    const delta = frames.find((f) => f.event === 'message_delta');
    assert.strictEqual(delta.data.usage.output_tokens, 5);
});

test('the terminal events come last, in order', () => {
    const events = streamFailureEvents({ partial: 'p', openBlock: 0, message: 'm' }).map((f) => f.event);
    assert.deepStrictEqual(events.slice(-3), ['error', 'message_delta', 'message_stop']);
});
