'use strict';
// Bounded page acquisition (09-23c).
//
// The failure this fixes, measured live:
//   ❌ Error: ProtocolError: Network.enable timed out. Increase the 'protocolTimeout'
//      setting in launch/connect calls for a higher timeout if needed.
//      at CdpCDPSession.send -> NetworkManager.addClient -> FrameManager.initialize
//      -> CdpPage._create -> Target.js:215
//
// That is `browser.newPage()` attaching to a target whose renderer is gone. It
// blocks for the full 240s protocolTimeout, so nothing ever throws and no recovery
// runs — the same "recovery keyed on failure never gets to fail" shape as the poll
// bug in the send loop. Every unbounded newPage() in the connect path was a
// four-minute stall.
//
// Two properties are pinned here:
//   1. withDeadline converts a hang into a fast, marked failure.
//   2. Every newPage in browser.js goes through it, and a selected tab is probed
//      for liveness before being driven — because page.url() is served from cached
//      metadata and happily returns a URL for a dead renderer.
//
// Functions are EXTRACTED from the shipped source by brace-walking, so deleting or
// unwiring them fails the tests instead of silently passing a stale copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'browser.js'), 'utf8');

// Returns the SOURCE of a named function, brace-matched from the shipped file.
// Source (not just the value) so tests can supply the closure a function needs —
// probePageAlive references withDeadline and RENDERER_PROBE_MS, and evaluating it
// bare would throw a ReferenceError that silently reads as "returned false".
function extractSource(name) {
    const start = SRC.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} must exist in browser.js`);
    let depth = 0;
    for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
            depth--;
            if (depth === 0) return SRC.slice(start, i + 1);
        }
    }
    throw new Error(`could not brace-match ${name}`);
}

function extractFunction(name) {
    // eslint-disable-next-line no-new-func
    return new Function(`${extractSource(name)}; return ${name};`)();
}

const withDeadline = extractFunction('withDeadline');

test('a hanging call is converted into a fast, marked rejection', async () => {
    const ms = 120;
    const t0 = Date.now();
    await assert.rejects(
        () => withDeadline(new Promise(() => { }), 'test-hang', ms),
        (e) => {
            assert.strictEqual(e.timedOut, true, 'the timeout must be identifiable');
            assert.match(e.message, /test-hang/, 'must name the operation');
            return true;
        }
    );
    const elapsed = Date.now() - t0;
    // The whole point: bounded by ms, NOT by the 240s protocolTimeout.
    assert.ok(elapsed < ms + 2000, `should reject near ${ms}ms, took ${elapsed}ms`);
});

test('a fast success passes through and keeps its value', async () => {
    assert.strictEqual(await withDeadline(Promise.resolve('pong'), 'test-ok', 5000), 'pong');
});

test('a genuine rejection keeps its own error, not a timeout', async () => {
    const boom = Object.assign(new Error('Network.enable failed'), { real: true });
    await assert.rejects(
        () => withDeadline(Promise.reject(boom), 'test-reject', 5000),
        (e) => {
            assert.strictEqual(e.real, true, 'the real error must survive');
            assert.notStrictEqual(e.timedOut, true, 'a real failure is not a timeout');
            return true;
        }
    );
});

test('EVERY newPage in the connect path is bounded', () => {
    // Behavioural coverage proves the helper works; this proves it is wired.
    // Without it the helper could be perfect and never called — which is exactly
    // how the previous fix passed its own unit tests while being unreachable.
    const raw = SRC.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /browser\.newPage\(\)/.test(line))
        // Calls already wrapped in withDeadline are the correct form. The exclusion
        // must allow ARGUMENTS inside newPage(...): page creation passes
        // {background:true} so Chrome cannot raise the window, and a literal
        // `newPage()` here would flag every correctly-bounded call.
        .filter(({ line }) => !/withDeadline\(browser\.newPage\(/.test(line));
    assert.deepStrictEqual(
        raw.map(r => r.n), [],
        `unbounded browser.newPage() at lines ${raw.map(r => r.n).join(', ')} — `
        + 'each one is a 240s stall on a dead renderer with no recovery'
    );
});

test('safeNewPage drops dead targets and retries exactly once on timeout', () => {
    const fn = extractSource('safeNewPage');

    assert.match(fn, /closeDeadWebchatTargets/, 'must clear the corpses before retrying');
    assert.match(fn, /e\.timedOut/, 'must only retry a TIMEOUT, not a real error');

    // Counted by the labels, not by brace-matching the function source: comments
    // inside the body contain braces, so a naive brace walk over-runs into the next
    // function and reports a bogus count. The labels are unique to each call site.
    const attempts = (fn.match(/'browser\.newPage\(\)'/g) || []).length;
    const retries = (fn.match(/'browser\.newPage\(\) retry'/g) || []).length;
    assert.strictEqual(attempts, 1, `expected exactly 1 initial attempt, found ${attempts}`);
    assert.strictEqual(retries, 1, `expected exactly 1 retry, found ${retries} — a loop here spins on a dead browser`);
});

test('the selected tab is probed for liveness before being driven', () => {
    // page.url() comes from cached target metadata, so selection cannot tell a live
    // tab from a corpse by URL. This assertion is what stops that regression.
    const probeIdx = SRC.indexOf('probePageAlive(page)');
    assert.ok(probeIdx > 0, 'connectToWebchatOnce must probe the selected page');
    assert.match(SRC, /💀 selected tab does not answer/, 'the probe must lead to replacement');
});

test('probePageAlive is bounded and cannot throw', async () => {
    // Evaluated with its real dependencies so the closure resolves — probePageAlive
    // calls withDeadline, and a bare evaluation would throw a ReferenceError that
    // reads as a false return rather than a test-harness fault.
    const prelude = `const RENDERER_PROBE_MS = 5000;\n${extractSource('withDeadline')}\n`;
    // eslint-disable-next-line no-new-func
    const probePageAlive = new Function(
        `${prelude}${extractSource('probePageAlive')}; return probePageAlive;`
    )();

    // A page whose evaluate never settles must return false, not hang.
    const deadPage = { isClosed: () => false, evaluate: () => new Promise(() => { }) };
    const t0 = Date.now();
    assert.strictEqual(await probePageAlive(deadPage, 120), false);
    assert.ok(Date.now() - t0 < 3000, 'the probe itself must be bounded');
    // And it must be safe on junk input rather than throwing.
    assert.strictEqual(await probePageAlive(null, 50), false);
    assert.strictEqual(await probePageAlive({ isClosed: () => true, evaluate: () => 2 }, 50), false);
    assert.strictEqual(await probePageAlive({ evaluate: () => Promise.resolve(2) }, 500), true);
    // A page that throws must read as dead, not propagate.
    assert.strictEqual(
        await probePageAlive({ evaluate: () => Promise.reject(new Error('Target closed')) }, 200),
        false
    );
});
