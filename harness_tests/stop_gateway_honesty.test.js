'use strict';
// stopGateway() must not report a stop that did not happen, and must not report a failure
// when the process really did exit.
//
// Two distinct defects, both measured:
//   1. It returned { stopped: true } immediately after SIGTERM. SIGTERM is a REQUEST — a
//      process that handles it (or ignores it) kept holding the port while the pidfile was
//      cleared, so the next start collided with a gateway nothing could reach any more.
//   2. The naive fix then failed a COOPERATIVE gateway. isAlive() uses signal 0, which a
//      ZOMBIE still accepts, so a process that answered SIGTERM and died was reported as
//      "did not exit". A guard that rejects everything is an outage, not a fix — hence the
//      second test here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DAEMON = path.join(__dirname, '..', 'cli', 'daemon.js');

// A fresh module bound to a scratch state dir, so tests never touch ~/.webchat.
function withScratchState(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-stopgw-'));
    const saved = process.env.WEBCHAT_STATE_DIR;
    process.env.WEBCHAT_STATE_DIR = dir;
    delete require.cache[require.resolve(DAEMON)];
    const D = require(DAEMON);
    try { return fn(D, dir); } finally {
        if (saved === undefined) delete process.env.WEBCHAT_STATE_DIR;
        else process.env.WEBCHAT_STATE_DIR = saved;
        delete require.cache[require.resolve(DAEMON)];
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
}

// argv must END with server.js so pidLooksLikeGateway() accepts it — that is what makes it a
// gateway to the CLI, and without it stopGateway() short-circuits with 'not running'.
function gatewayChild({ ignoreSigterm }) {
    const body = ignoreSigterm
        ? 'process.on("SIGTERM",function(){});setTimeout(function(){},20000)'
        : 'setTimeout(function(){},20000)';
    const c = spawn(process.execPath, ['-e', body, 'server.js'], { stdio: 'ignore' });
    return { pid: c.pid, kill: () => { try { c.kill('SIGKILL'); } catch {} } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a cooperative gateway is reported stopped, and the pidfile is cleared', async () => {
    const g = gatewayChild({ ignoreSigterm: false });
    await wait(250);
    try {
        withScratchState((D, dir) => {
            D.writePid('gateway', g.pid);
            const r = D.stopGateway(D.defaultGatewayPort());
            assert.strictEqual(r.stopped, true, 'a gateway that exits must be reported stopped');
            assert.strictEqual(fs.existsSync(path.join(dir, 'gateway.pid')), false,
                'the pidfile must be cleared once the process is gone');
        });
    } finally { g.kill(); }
});

test('stopGateway does not report success before the process is actually gone', async () => {
    // The process ignores SIGTERM, so the first signal changes nothing. It must still be
    // escalated through, and the end state must be a genuine exit — never a cleared pidfile
    // over a live process.
    const g = gatewayChild({ ignoreSigterm: true });
    await wait(250);
    try {
        withScratchState((D) => {
            D.writePid('gateway', g.pid);
            const r = D.stopGateway(D.defaultGatewayPort());
            if (r.stopped) {
                // Claiming success is only allowed if it truly exited.
                assert.strictEqual(gone(g.pid), true,
                    'reported stopped:true while the gateway was still alive');
            } else {
                // Refusing is only allowed if the pidfile survived, so it stays reachable.
                assert.ok(fs.existsSync(D.pidFile('gateway')),
                    'a failed stop must leave the pidfile so the process can still be reached');
            }
        });
    } finally { g.kill(); }
});

test('a process that survives SIGTERM is escalated, not abandoned', async () => {
    // Without escalation the fixture would live out its 20s. Prove stopGateway ends it.
    const g = gatewayChild({ ignoreSigterm: true });
    await wait(250);
    try {
        withScratchState((D) => {
            D.writePid('gateway', g.pid);
            D.stopGateway(D.defaultGatewayPort());
            assert.strictEqual(gone(g.pid), true,
                'a SIGTERM-ignoring gateway must be escalated so it cannot hold the port');
        });
    } finally { g.kill(); }
});

test('a zombie is not "still alive" (the bug the first fix introduced)', async () => {
    // A child that exits becomes a zombie until its parent reaps it, and a zombie still
    // accepts signal 0. isAlive() says true for it; processExited() must say true as well,
    // or a successful stop is mis-reported as a failure.
    const c = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await wait(300);   // exits, and this test process has not reaped it yet
    try {
        withScratchState((D) => {
            assert.strictEqual(D.processExited(c.pid), true,
                'an exited (zombie) process must count as exited');
        });
    } finally { try { c.kill('SIGKILL'); } catch {} }
});

test('a running process is not reported as exited', async () => {
    const g = gatewayChild({ ignoreSigterm: false });
    await wait(250);
    try {
        withScratchState((D) => {
            assert.strictEqual(D.processExited(g.pid), false,
                'a live process must not be reported as exited');
        });
    } finally { g.kill(); }
});

test('processExited is safe for pids that do not exist', async () => {
    withScratchState((D) => {
        assert.strictEqual(D.processExited(undefined), true);
        assert.strictEqual(D.processExited(999999), true);
        assert.strictEqual(D.processExited('nonsense'), true);
    });
});

function gone(pid) {
    try { fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return true; }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0);
    return state === 'Z' || state === 'X';
}

// ── the hub had the same two defects, so it gets the same coverage ───────────
// hubRunning() accepted any live pid (liveness is not identity), and stopHub() claimed success
// right after SIGTERM. Both now share terminateAndConfirm() with stopGateway, so a fix to one
// cannot drift from the other.

function hubChild({ ignoreSigterm }) {
    const body = ignoreSigterm
        ? 'process.on("SIGTERM",function(){});setTimeout(function(){},20000)'
        : 'setTimeout(function(){},20000)';
    // argv must END with hub-server.js for pidLooksLikeHub() to accept it.
    const c = spawn(process.execPath, ['-e', body, 'hub-server.js'], { stdio: 'ignore' });
    return { pid: c.pid, kill: () => { try { c.kill('SIGKILL'); } catch {} } };
}

test('hubRunning() rejects a live pid that is not the hub', async () => {
    const c = spawn(process.execPath, ['-e', 'setTimeout(function(){},20000)'], { stdio: 'ignore' });
    await wait(250);
    try {
        withScratchState((D) => {
            D.writePid('hub', c.pid);
            assert.strictEqual(D.hubRunning(), 0,
                'a reused pid must not read as a running hub');
        });
    } finally { try { c.kill('SIGKILL'); } catch {} }
});

test('hubRunning() still reports a real hub pid', async () => {
    const h = hubChild({ ignoreSigterm: false });
    await wait(250);
    try {
        withScratchState((D) => {
            D.writePid('hub', h.pid);
            assert.strictEqual(D.hubRunning(), h.pid, 'a genuine hub pid must still be reported');
        });
    } finally { h.kill(); }
});

test('stopHub() verifies the process actually stopped', async () => {
    const h = hubChild({ ignoreSigterm: true });
    await wait(250);
    try {
        withScratchState((D) => {
            D.writePid('hub', h.pid);
            D.stopHub();
            assert.strictEqual(gone(h.pid), true,
                'a SIGTERM-ignoring hub must be escalated, not left holding its port');
        });
    } finally { h.kill(); }
});
