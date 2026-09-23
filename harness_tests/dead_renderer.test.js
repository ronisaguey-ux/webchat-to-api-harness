'use strict';
// Dead-renderer detection + recovery.
//
// THE BUG THIS PINS (measured 2026-09-23): a Chromium renderer died while the
// browser stayed healthy. CDP evaluates hung until the 240s protocolTimeout and
// threw
//   "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting..."
// which is NOT the same string as the `Protocol error (Runtime.callFunctionOn)`
// already in STALE_HANDLE_RE. So `isStaleHandleError` said no, recovery never
// fired, the send was polled as "page busy?" until the 900s idle deadline, and
// the whole execution run died with `waitForResponse made no progress for
// 915000ms`. Every chrome process sat at 0.0% CPU the entire time.
//
// The classifier is the load-bearing part: it decides whether a dead tab gets
// recovered or costs 15 minutes. It is pure, so it is testable without a browser.
const test = require('node:test');
const assert = require('node:assert');
const browser = require('../browser.js');

// The exact string Chromium produced, copied from the live failure.
const REAL_DEAD_RENDERER =
    "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect";

test('the real failure string is classified as a renderer timeout', () => {
    assert.strictEqual(
        browser.isRendererTimeoutError(REAL_DEAD_RENDERER),
        true,
        'the exact message from the live failure must be recognised — this is what did not match before',
    );
});

test('it is recognised when the message is nested on an Error object', () => {
    const e = new Error(REAL_DEAD_RENDERER);
    assert.strictEqual(browser.isRendererTimeoutError(e), true);
});

test('a detached / closed target still classifies (the pre-existing cases)', () => {
    for (const msg of [
        'Protocol error (Runtime.callFunctionOn): Target closed.',
        'Session closed. Most likely the page has been closed.',
        'Execution context was destroyed, most likely because of a navigation.',
        'Cannot find context with specified id',
        'detached Frame',
    ]) {
        assert.strictEqual(browser.isRendererTimeoutError(msg), true, `should match: ${msg}`);
    }
});

test('an unrelated error is NOT classified as a renderer timeout', () => {
    // Non-vacuous floor: a catch-all regex would pass every assertion above and
    // then recover a perfectly healthy page on any error at all.
    for (const msg of [
        'ECONNREFUSED 127.0.0.1:8081',
        'DeepSeek stream error: Messages too frequent',
        'prompt too large (9000000 chars > 600000)',
        'Length limit reached',
        '',
    ]) {
        assert.strictEqual(browser.isRendererTimeoutError(msg), false, `must NOT match: ${msg}`);
    }
});

test('null / undefined are handled without throwing', () => {
    assert.strictEqual(browser.isRendererTimeoutError(null), false);
    assert.strictEqual(browser.isRendererTimeoutError(undefined), false);
});

test('probing with no page reports dead rather than throwing', async () => {
    // The module is imported without ever connecting, so there is no page.
    // A probe must answer "not alive", never throw — it runs inside a catch path,
    // where a throw would replace the real error with a confusing one.
    const alive = await browser.probeRendererAlive(500);
    assert.strictEqual(alive, false);
});

test('dropping a dead renderer is safe when no browser is connected', async () => {
    const closed = await browser.dropDeadRenderer('test');
    assert.strictEqual(typeof closed, 'number');
});
