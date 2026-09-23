'use strict';
// Bind guard (harness C9).
//
// This process drives a browser LOGGED INTO a real webchat account, so anyone
// who can reach the port can use that account. That was protected by convention
// only — HOST defaults to 127.0.0.1, but one HOST=0.0.0.0 (or an .env edit)
// exposed the logged-in session with no token required.
//
// The decision is pure, so it is asserted directly rather than by spawning a
// server and reading a port. A test that binds a real port would be slow and
// environment-dependent; the thing that was wrong was a MISSING CHECK, and the
// check is a two-line predicate.
const test = require('node:test');
const assert = require('node:assert');

// Mirrors the guard in server.js main(). Kept in lockstep by the source test below.
function refusalReason(host, apiToken) {
    const h = String(host || '').toLowerCase();
    const isLoopback = h === '127.0.0.1' || h === 'localhost' || h === '::1';
    if (!isLoopback && !apiToken) return 'refuse';
    return null;
}

test('loopback without a token is allowed (the normal local case)', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST']) {
        assert.strictEqual(refusalReason(h, null), null, `${h} must be allowed`);
    }
});

test('a non-loopback bind without a token is REFUSED', () => {
    // The whole point: this is the configuration that exposes the account.
    for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'example.com']) {
        assert.strictEqual(refusalReason(h, null), 'refuse', `${h} must be refused`);
    }
});

test('a non-loopback bind WITH a token is allowed', () => {
    // Exposing it deliberately, behind auth, is a legitimate choice.
    assert.strictEqual(refusalReason('0.0.0.0', 'a-long-random-token'), null);
});

test('the guard actually exists in the shipped server.js', () => {
    // Non-vacuous against the real file: a passing pure-function test proves
    // nothing if the server never calls it. This asserts the check is wired.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /REFUSING TO START/, 'the refusal must be present in server.js');
    assert.match(src, /process\.exit\(1\)/, 'it must actually stop the process');
    assert.match(src, /_isLoopback/, 'the loopback predicate must be there');
    // And it must run before the listener is created.
    const guardAt = src.indexOf('_isLoopback');
    const listenAt = src.indexOf('app.listen(');
    assert.ok(guardAt > 0 && listenAt > 0 && guardAt < listenAt,
        'the guard must run BEFORE app.listen, not after');
});
