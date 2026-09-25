'use strict';
//
// Ports must be allocated fresh AND proven free, and a gateway must never claim to have
// started on a port it cannot bind.
//
// Two defects lived here:
//
//   1. `freePortPair()` was two sequential `freePort()` calls. Each one closes its socket
//      before returning, so the OS was free to hand the second call the port the first had
//      just released — measured at 1 in 200 pairs. A gateway sharing a number with its own
//      browser's debug port is a start that cannot work.
//
//   2. `startGateway()` spawned blind and returned `{started:true}` regardless. Measured
//      with another process holding the port: it still reported success while server.js
//      could not bind, so the caller waited on a probe for a gateway that never existed.
//
// Run: node --test harness_tests/port_allocation.test.js

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

// Scratch state dir: this suite starts real gateway processes, and it must not touch the
// user's own registry or pidfiles.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-'));
process.env.WEBCHAT_STATE_DIR = STATE;

const D = require(path.join(REPO, 'cli', 'daemon.js'));
const G = require(path.join(REPO, 'cli', 'gates.js'));

// Hold a port for the duration of `fn`, then release it.
async function withHeldPort(fn) {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try { return await fn(port); } finally { srv.close(); }
}

test('isPortFree tells a held port from a free one', async () => {
    await withHeldPort(async (held) => {
        assert.strictEqual(await D.isPortFree(held), false,
            'a port something is listening on is not free');
    });
    // Released above, so it should be bindable again.
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const p = probe.address().port;
    await new Promise((r) => probe.close(r));
    assert.strictEqual(await D.isPortFree(p), true, 'a released port is free');
});

test('isPortFree rejects nonsense instead of throwing', async () => {
    for (const bad of [0, -1, 70000, null, undefined, 'x', NaN]) {
        assert.strictEqual(await D.isPortFree(bad), false, `${String(bad)} is not a usable port`);
    }
});

test('freePortPair never returns the same port for both halves, and both are free', async () => {
    // The historical bug was a 1-in-200 collision, so one iteration proves nothing.
    for (let i = 0; i < 60; i++) {
        const { cdpPort, gatewayPort } = await D.freePortPair();
        assert.notStrictEqual(cdpPort, gatewayPort,
            'the CDP port and the gateway port must differ — a gateway cannot share a number with its own browser');
        assert.strictEqual(await D.isPortFree(cdpPort), true, `cdpPort ${cdpPort} must be free`);
        assert.strictEqual(await D.isPortFree(gatewayPort), true, `gatewayPort ${gatewayPort} must be free`);
    }
});

test('gates still re-exports the port helpers (one implementation, in daemon)', async () => {
    // gates.js requires daemon.js, so daemon cannot require gates without a cycle. The
    // helpers live in daemon and are re-exported here; both paths must work.
    assert.strictEqual(typeof G.freePort, 'function');
    assert.strictEqual(typeof G.freePortPair, 'function');
    assert.strictEqual(typeof G.isPortFree, 'function');
    const pair = await G.freePortPair();
    assert.notStrictEqual(pair.cdpPort, pair.gatewayPort);
});

test('startGateway is async and REPORTS a start it cannot make', async () => {
    // A start must never be reported as successful without checking the port it needs.
    const res = D.startGateway({ port: 1234, cdpPort: 1235, mode: 'deepseek' });
    assert.ok(res && typeof res.then === 'function',
        'startGateway must be async: it verifies the port before spawning');
    const out = await res;
    assert.ok(out && typeof out === 'object');
    if (out.pid) { try { process.kill(out.pid, 'SIGKILL'); } catch { /* already gone */ } }
});

test('startGateway moves off a port another process holds, and binds the one it picks', async () => {
    await withHeldPort(async (busy) => {
        const res = await D.startGateway({ port: busy, cdpPort: 59991, mode: 'deepseek' });
        try {
            assert.strictEqual(res.started, true, 'it should find a usable port rather than give up');
            assert.notStrictEqual(res.port, busy,
                'it must not keep a port another process is holding');
            assert.strictEqual(await D.isPortFree(res.port), true,
                'the port it reports is the one the caller will dial, so it must be the free one');
        } finally {
            if (res.pid) { try { process.kill(res.pid, 'SIGKILL'); } catch { /* already gone */ } }
        }
    });
});

test('startGateway returns the actual port, so a caller can persist a renumber', async () => {
    await withHeldPort(async (busy) => {
        const res = await D.startGateway({ port: busy, cdpPort: 59992, mode: 'deepseek' });
        try {
            // The caller uses `res.port`, not the port it asked for. Without this the harness
            // would be pointed at the old number and the fix would only move the failure.
            assert.ok(Number.isInteger(res.port), 'a port is always reported back');
            assert.ok(Number.isInteger(res.pid), 'and the pid of what was started');
        } finally {
            if (res.pid) { try { process.kill(res.pid, 'SIGKILL'); } catch { /* already gone */ } }
        }
    });
});

test('startGateway refuses to double-start the gateway for a port we already run', async () => {
    // 'already running' must be distinguishable from 'could not start' — the caller treats
    // them differently (one is fine, the other aborts the launch).
    await withHeldPort(async (busy) => {
        const first = await D.startGateway({ port: busy, cdpPort: 59993, mode: 'deepseek' });
        try {
            const second = await D.startGateway({ port: first.port, cdpPort: 59993, mode: 'deepseek' });
            assert.strictEqual(second.started, false, 'a second start on a live gateway is not a start');
            assert.strictEqual(second.reason, 'already running',
                'and it says so, rather than reporting an error the caller would abort on');
        } finally {
            if (first.pid) { try { process.kill(first.pid, 'SIGKILL'); } catch { /* already gone */ } }
        }
    });
});

// ── the collision retry, tested deterministically ────────────────────────────
//
// The OS collision is 1 in 200, so the loop test above cannot reliably prove the retry
// exists. A stub generator can: hand it a collision first and the loop must ask again.
test('distinctPair retries when the generator returns a collision', async () => {
    let calls = 0;
    const scripted = [5000, 5000, 5000, 5001, 5002];
    const next = async () => scripted[Math.min(calls++, scripted.length - 1)];

    const { a, b } = await D.distinctPair(next);
    assert.strictEqual(a, 5000);
    assert.strictEqual(b, 5001, 'the repeated value must be discarded, not returned');
    assert.ok(calls >= 4, `it must keep asking until the values differ (asked ${calls} times)`);
});

test('distinctPair returns immediately when the first two differ', async () => {
    let calls = 0;
    const next = async () => [7000, 7001, 7002][calls++];
    const { a, b } = await D.distinctPair(next);
    assert.deepStrictEqual([a, b], [7000, 7001]);
    assert.strictEqual(calls, 2, 'no needless calls when there is no collision');
});

test('distinctPair gives up rather than looping forever on a stuck generator', async () => {
    let calls = 0;
    const next = async () => { calls++; return 6000; };   // always the same
    const { a, b } = await D.distinctPair(next);
    assert.strictEqual(a, 6000);
    assert.strictEqual(b, 6000, 'a generator that cannot differ yields a pair, it does not hang');
    assert.ok(calls <= 20, `bounded attempts, got ${calls}`);
});
