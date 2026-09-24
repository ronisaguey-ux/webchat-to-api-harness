'use strict';
// Regression tests for two reported harness defects (2026-09-21):
//  1. a missing lock PARENT directory made every request wait out the lock
//     timeout instead of creating the directory (Windows: /tmp -> C:\tmp).
//  2. the fresh-chat reset fired from countedSend(), so a tool-loop send could
//     navigate the tab mid-response and break multi-tool requests.
//
// These exercise the REAL implementation (server.js) with a stubbed browser
// module, so they would FAIL against the pre-fix code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const calls = { openNewChat: 0, sendPrompt: 0 };

// Stub ./browser BEFORE server.js destructures it, so no chrome is launched.
const browserPath = require.resolve('../src/browser/browser.js');
const stub = new Proxy({}, {
    get(_t, k) {
        if (k === 'openNewChat') return async () => { calls.openNewChat += 1; };
        if (k === 'openNewChatAndSeed') return async () => ({ url: 'stub' });
        if (k === 'sendPrompt') return async () => { calls.sendPrompt += 1; return 'stub answer'; };
        if (k === 'getToolDefinitions') return () => [];
        return async () => {};
    },
});
require.cache[browserPath] = {
    id: browserPath, filename: browserPath, loaded: true, exports: stub, children: [], paths: [],
};

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
process.env.WEBCHAT_URL = 'https://chat.deepseek.com/a/chat/s/TEST';
process.env.WEBCHAT_ACCOUNT = 'unittest';
process.env.DEEPSEEK_LOCK_TIMEOUT_MS = '2500';   // keep a failing test fast
process.env.NEW_CHAT_EVERY_SENDS = '1';          // trip the reset on the first send
process.env.SEND_SPACING_FILE = path.join(WORK, 'last_send');
process.env.RATE_LIMIT_STATE_DIR = WORK;

const S = require('../server.js');

test('the mutex module loads without booting a server', () => {
    assert.ok(S.acquireDeepSeekLock, 'acquireDeepSeekLock exported');
    assert.ok(S.needsSingleThread(), 'the deepseek URL is recognised as single-threaded');
});

test('BUG 1: a missing lock PARENT is created, not waited on', async () => {
    // nested parent that does not exist yet - the exact reported failure
    const lock = path.join(WORK, 'does', 'not', 'exist', 'webchat_mutex_unittest');
    assert.ok(!fs.existsSync(path.dirname(lock)), 'precondition: parent is absent');
    process.env.WEBCHAT_LOCK_DIR = lock;
    delete require.cache[require.resolve('../server.js')];
    const S2 = require('../server.js');

    const t0 = Date.now();
    await S2.acquireDeepSeekLock();          // must acquire, not time out
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `acquired promptly (took ${ms}ms)`);
    assert.ok(fs.existsSync(lock), 'the lock directory now exists');
    S2.releaseDeepSeekLock();
    assert.ok(!fs.existsSync(lock), 'release removed the lock');
});

test('BUG 1: an unusable lock path surfaces a clear error, not a hang', async () => {
    // parent is a FILE -> mkdir must fail ENOTDIR/EEXIST, never be read as "held"
    const asFile = path.join(WORK, 'a-file');
    fs.writeFileSync(asFile, 'x');
    process.env.WEBCHAT_LOCK_DIR = path.join(asFile, 'webchat_mutex_unittest');
    delete require.cache[require.resolve('../server.js')];
    const S3 = require('../server.js');

    const t0 = Date.now();
    await assert.rejects(
        () => S3.acquireDeepSeekLock(),
        (e) => /webchat mutex: cannot (create|inspect)/.test(e.message),
        'a filesystem fault must be named, not waited out'
    );
    assert.ok(Date.now() - t0 < 2000, 'it failed fast instead of burning the lock timeout');
});

test('BUG 2: countedSend never opens a fresh chat (the mid-response reset)', async () => {
    process.env.WEBCHAT_LOCK_DIR = path.join(WORK, 'lock2');
    delete require.cache[require.resolve('../server.js')];
    const S4 = require('../server.js');
    S4.__test.setSendCount(0);
    S4.__test.setRequestInFlight(true);      // inside a request
    calls.openNewChat = 0;

    // NEW_CHAT_EVERY_SENDS=1, so the OLD code opened a fresh chat on this very
    // call and navigated the tab away mid-response.
    try { await S4.countedSend('hello', []); } catch { /* send path may stub-fail */ }

    assert.strictEqual(calls.openNewChat, 0, 'countedSend must NOT navigate the tab');
    assert.strictEqual(S4.__test.getSendCount(), 1, 'the send IS still counted');
});

test('BUG 2: the reset still happens, but only at a request boundary', async () => {
    process.env.WEBCHAT_LOCK_DIR = path.join(WORK, 'lock3');
    delete require.cache[require.resolve('../server.js')];
    const S5 = require('../server.js');
    S5.__test.setSendCount(99);
    calls.openNewChat = 0;

    S5.__test.setRequestInFlight(true);
    assert.strictEqual(await S5.maybeResetThreadAtBoundary('test'), false);
    assert.strictEqual(calls.openNewChat, 0, 'refused while a request is in flight');

    S5.__test.setRequestInFlight(false);
    assert.strictEqual(await S5.maybeResetThreadAtBoundary('test'), true);
    assert.strictEqual(calls.openNewChat, 1, 'performed between requests');
    assert.strictEqual(S5.__test.getSendCount(), 0, 'counter reset after the swap');
});

test('NEW_CHAT_EVERY_SENDS=0 disables the automatic reset entirely', async () => {
    process.env.WEBCHAT_LOCK_DIR = path.join(WORK, 'lock4');
    process.env.NEW_CHAT_EVERY_SENDS = '0';
    delete require.cache[require.resolve('../server.js')];
    const S6 = require('../server.js');
    S6.__test.setSendCount(999);
    S6.__test.setRequestInFlight(false);
    calls.openNewChat = 0;

    assert.strictEqual(await S6.maybeResetThreadAtBoundary('test'), false);
    assert.strictEqual(calls.openNewChat, 0, 'disabled means disabled');
    process.env.NEW_CHAT_EVERY_SENDS = '1';
});

test('teardown', () => {
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
});
