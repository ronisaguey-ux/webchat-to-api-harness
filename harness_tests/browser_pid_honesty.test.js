'use strict';
// browserRunning() must not accept ANY live pid as "a browser".
//
// isAlive() only answers "may I signal this pid?", so pid reuse made a stale pidfile read as a
// running browser: the CLI showed a window that was not there, and launchBrowser() refused to
// start a real one. Same class as the gateway pid bug already fixed (pidLooksLikeGateway).
//
// Note on the test itself: it must pass an EXPLICIT pid and never test process.pid. A process
// that merely MENTIONS "chrome" or "--remote-debugging-port" in its own argv (a test runner, a
// shell one-liner) would otherwise be misread as a browser — the same self-matching trap that
// makes `pgrep -f <pattern>` kill the shell that typed it.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const D = require(path.join(__dirname, '..', 'cli', 'daemon.js'));

// A process that HOLDS for a few seconds with the given extra argv entries visible in /proc.
//
// NOT `bash -c 'sleep 3' <extras>`: bash execs a single simple command, so it replaces itself
// and /proc/<pid>/cmdline becomes just `sleep 3` — the extras are gone and the fixture silently
// stops testing what it claims to (measured: ["sleep","3",""]).
function child(extraArgv) {
    const c = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 4000)', ...extraArgv],
        { stdio: 'ignore' });
    return {
        pid: c.pid,
        done: () => new Promise((r) => { try { c.kill('SIGKILL'); } catch {} setTimeout(r, 60); }),
    };
}

test('a browser-shaped argv is accepted', async () => {
    const c = child(['chrome', '--remote-debugging-port=19222']);
    await new Promise((r) => setTimeout(r, 150));
    try {
        assert.strictEqual(D.pidLooksLikeBrowser(c.pid), true,
            'a chrome process carrying --remote-debugging-port is the real thing');
    } finally { await c.done(); }
});

test('a live process that is not a browser is rejected', async () => {
    const c = child([]);
    await new Promise((r) => setTimeout(r, 150));
    try {
        assert.strictEqual(D.pidLooksLikeBrowser(c.pid), false,
            'liveness is not identity — a reused pid must not read as a browser');
    } finally { await c.done(); }
});

test('a chrome without a debug port is rejected (it is not the one we can drive)', async () => {
    const c = child(['chrome']);
    await new Promise((r) => setTimeout(r, 150));
    try {
        assert.strictEqual(D.pidLooksLikeBrowser(c.pid), false,
            'without --remote-debugging-port we cannot attach to it, so it is not our browser');
    } finally { await c.done(); }
});

test('a dead / unreadable pid is rejected rather than assumed', async () => {
    assert.strictEqual(D.pidLooksLikeBrowser(undefined), false);
    assert.strictEqual(D.pidLooksLikeBrowser('not-a-pid'), false);
    // A pid that certainly does not exist.
    assert.strictEqual(D.pidLooksLikeBrowser(999999), false);
});

test('gateway and browser checks are not interchangeable', async () => {
    // A chrome-shaped process must not pass as a gateway, and vice versa. Two different
    // questions; one shared wrong answer would mis-report both.
    const c = child(['chrome', '--remote-debugging-port=19222']);
    await new Promise((r) => setTimeout(r, 150));
    try {
        assert.strictEqual(D.pidLooksLikeBrowser(c.pid), true);
        assert.strictEqual(D.pidLooksLikeGateway(c.pid), false,
            'a browser is not a gateway');
    } finally { await c.done(); }
});

// ── the user-visible behaviour ────────────────────────────────────────────────
// The tests above check the predicate. This one drives browserRunning() itself through a
// scratch state dir, because the PREDICATE being right is not the same as the CALLER using
// it — reverting browserRunning to its old body left the predicate tests green.

const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function withScratchState(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-browserpid-'));
    const saved = process.env.WEBCHAT_STATE_DIR;
    process.env.WEBCHAT_STATE_DIR = dir;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'cli', 'daemon.js'))];
    const fresh = require(path.join(__dirname, '..', 'cli', 'daemon.js'));
    try { return fn(fresh, dir); } finally {
        if (saved === undefined) delete process.env.WEBCHAT_STATE_DIR;
        else process.env.WEBCHAT_STATE_DIR = saved;
        delete require.cache[require.resolve(path.join(__dirname, '..', 'cli', 'daemon.js'))];
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
}

test('browserRunning() rejects a live pid that is not a browser', async () => {
    // A neutral, definitely-not-chrome process holding the pid the pidfile names. This is
    // exactly what pid reuse looks like on a machine that has been up for a while.
    const c = child([]);
    await new Promise((r) => setTimeout(r, 150));
    try {
        withScratchState((fresh, dir) => {
            fresh.writePid('browser', c.pid);
            const got = fresh.browserRunning();
            assert.strictEqual(got, null,
                'a live pid that is not a browser must not read as a running browser');
            assert.strictEqual(fs.existsSync(path.join(dir, 'browser.pid')), false,
                'the stale pidfile must be cleared so the caller starts a real browser');
        });
    } finally { await c.done(); }
});

test('browserRunning() still reports a real browser-shaped pid', async () => {
    // The guard must not reject everything — that would be an outage, not a fix.
    const c = child(['chrome', '--remote-debugging-port=19222']);
    await new Promise((r) => setTimeout(r, 150));
    try {
        withScratchState((fresh) => {
            fresh.writePid('browser', c.pid);
            assert.strictEqual(fresh.browserRunning(), c.pid,
                'a genuine browser pid must still be reported as running');
        });
    } finally { await c.done(); }
});
