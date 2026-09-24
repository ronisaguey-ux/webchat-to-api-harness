'use strict';
//
// A submit_answer that follows ZERO tool calls must not read as a completed job.
//
// Measured failure this guards: a plan run executed no tools at all and then
// answered "Remediation plan execution completed successfully. All active waves and
// steps have been addressed, verified, and logged..." — the gateway returned HTTP 200
// with that text, so the caller could not distinguish a finished job from a
// fabricated one and reported success over untouched code.
//
const test = require('node:test');
const assert = require('node:assert');
const { __test } = require('../server.js');
const { markUnverifiedSubmit, UNVERIFIED_MARKER } = __test;

const FABRICATED = 'Remediation plan execution completed successfully. All active waves and steps have been addressed, verified, and logged in accordance with the specifications.';

test('a submit with no tool work behind it is marked', () => {
    const r = markUnverifiedSubmit(FABRICATED, { offeredWorkTools: true, workToolsRun: 0 });
    assert.strictEqual(r.marked, true);
    assert.ok(r.text.startsWith(UNVERIFIED_MARKER), 'the marker must come first, before the claim');
    assert.ok(r.text.includes(FABRICATED), 'the original text is preserved, not replaced');
});

test('the marker states the fact and does not accuse', () => {
    // It must say what the gateway knows (nothing ran), not assert a lie — the
    // gateway cannot read intent, and a false accusation in a log is its own bug.
    assert.match(UNVERIFIED_MARKER, /no tools were run/i);
    assert.doesNotMatch(UNVERIFIED_MARKER, /lie|lying|fabricat|dishonest/i);
});

test('a submit AFTER real work is untouched', () => {
    const r = markUnverifiedSubmit('Done: edited foo.py and ran the tests.', { offeredWorkTools: true, workToolsRun: 3 });
    assert.strictEqual(r.marked, false);
    assert.strictEqual(r.text, 'Done: edited foo.py and ran the tests.');
});

test('exactly one tool is enough to count as work', () => {
    const r = markUnverifiedSubmit('done', { offeredWorkTools: true, workToolsRun: 1 });
    assert.strictEqual(r.marked, false);
});

test('a direct answer with no tools offered is NOT marked', () => {
    // Conversation mode / noTools: no tool was expected, so their absence means
    // nothing. Marking here would put a warning on every plain answer.
    for (const opts of [{ offeredWorkTools: false, workToolsRun: 0 }]) {
        const r = markUnverifiedSubmit('2 + 2 is 4.', opts);
        assert.strictEqual(r.marked, false);
        assert.strictEqual(r.text, '2 + 2 is 4.');
    }
});

test('an empty submit is still marked when no work ran', () => {
    const r = markUnverifiedSubmit('', { offeredWorkTools: true, workToolsRun: 0 });
    assert.strictEqual(r.marked, true);
});
