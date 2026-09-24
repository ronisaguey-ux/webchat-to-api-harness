'use strict';
// Bounded poll awaits (09-23b).
//
// Why this exists: the dead-renderer recovery only runs when a poll THROWS, but a
// poll against a dead renderer does not throw promptly — `page.evaluate` is bounded
// only by protocolTimeout (240000ms) and each loop iteration makes two such calls.
// Measured: a send sat at outstandingMs 420542 with the renderer dead and the
// failure counter still at 0, so recovery never became reachable. These tests pin
// the two properties that fix that: a hang becomes a fast failure, and both poll
// awaits actually go through the bound.
//
// boundPoll is EXTRACTED from the shipped browser.js by brace-walking, not copied —
// a copy would keep passing after the shipped function was edited or removed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser', 'browser.js'), 'utf8');

// Pull `const boundPoll = (...) => { ... };` out of the source verbatim.
function extractBoundPoll() {
    const start = SRC.indexOf('const boundPoll = (');
    assert.ok(start > 0, 'boundPoll must exist in browser.js');
    const braceStart = SRC.indexOf('{', SRC.indexOf('=>', start));
    let depth = 0;
    let i = braceStart;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    const body = SRC.slice(start, i + 1);
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return boundPoll;`)();
}

const boundPoll = extractBoundPoll();

test('a promise that never settles is converted into a fast rejection', async () => {
    const ms = 120;
    const never = new Promise(() => { });
    const t0 = Date.now();
    await assert.rejects(
        () => boundPoll(never, 'test-hang', ms),
        (e) => {
            assert.strictEqual(e.pollTimeout, true, 'must be marked so callers can route it');
            assert.match(e.message, /test-hang/, 'must name which poll hung');
            return true;
        }
    );
    const elapsed = Date.now() - t0;
    // The whole point: bounded by ms, NOT by protocolTimeout (240000).
    assert.ok(elapsed < ms + 2000, `should reject near ${ms}ms, took ${elapsed}ms`);
});

test('a fast success passes through untouched and clears its timer', async () => {
    const t0 = Date.now();
    const v = await boundPoll(Promise.resolve('ok'), 'test-fast', 5000);
    assert.strictEqual(v, 'ok');
    assert.ok(Date.now() - t0 < 1000, 'must not wait for the bound');
    // If the timer were not cleared, this handle would keep the process alive past
    // the test run — node:test reports a hanging process in that case.
});

test('a rejecting promise keeps its OWN error, not the timeout error', async () => {
    // A genuine protocol error must still reach the failure counter with its real
    // message; only a HANG should look like a timeout.
    const boom = Object.assign(new Error('Runtime.callFunctionOn timed out'), { real: true });
    await assert.rejects(
        () => boundPoll(Promise.reject(boom), 'test-reject', 5000),
        (e) => {
            assert.strictEqual(e.real, true, 'the real error must survive');
            assert.notStrictEqual(e.pollTimeout, true);
            return true;
        }
    );
});

test('BOTH poll awaits are bounded, and the tee routes a timeout into recovery', () => {
    // Behavioural coverage above proves the helper works; this proves it is WIRED.
    // Without it the helper could be perfect and never called.
    const teeBounded = /boundPoll\(\s*readStreamedAnswer\(/.test(SRC);
    const snapBounded = /boundPoll\(\s*snapshotChat\(/.test(SRC);
    assert.ok(teeBounded, 'readStreamedAnswer must go through boundPoll');
    assert.ok(snapBounded, 'snapshotChat must go through boundPoll');

    // A tee timeout must COUNT toward recovery, not fall through silently.
    assert.match(SRC, /if \(e\.pollTimeout\) await handlePollFailure\(e\)/,
        'the stream-tee catch must route poll timeouts into the shared handler');

    // And there must be exactly ONE failure handler (the duplicated inline block
    // was what let one call site drift from the other).
    const increments = (SRC.match(/_pollFailures \+= 1/g) || []).length;
    assert.strictEqual(increments, 1, `failure counting must live in one place, found ${increments}`);

    // The bound must be DEFINED before it is USED. Anchoring on the first
    // `while (Date.now() < deadline)` is wrong — browser.js has three of them — so
    // this compares against the first actual call site instead.
    const definedAt = SRC.indexOf('const boundPoll');
    const firstUse = SRC.indexOf('boundPoll(');
    assert.ok(definedAt > 0 && firstUse > definedAt,
        'boundPoll must be defined before its first use');
});
