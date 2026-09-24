'use strict';
// TUI empty-state / health-field fixes (harness C10, §9 step 3).
//
// Two defects, both silent:
//
//   G5 — `probeGateway` read `parsed.alive`, but /health emits `browserAlive`
//        (and `ok`). There is no `alive` key, so `gw.attached` was ALWAYS false
//        and the dashboard's only success state ("up · browser attached") was
//        unreachable. A success indicator that can never fire is an empty state
//        pretending to be a status line.
//
//   The Doctor screen did not mention API_TOKEN at all, so a user who set a
//        non-loopback host learned the gateway refuses to start only when it
//        refused.
//
// The probe is exercised against a REAL local HTTP listener rather than a stub,
// because the bug was a misread of the real response body.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../cli/daemon');

function serveHealth(body, status = 200) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        });
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
}

function close(srv) { return new Promise((r) => srv.close(r)); }

test('attached is true when /health reports browserAlive:true', async () => {
    const { srv, port } = await serveHealth({ ok: true, browserAlive: true, wedged: false, outstandingMs: 0 });
    try {
        const gw = await D.probeGateway('127.0.0.1', port);
        assert.strictEqual(gw.up, true);
        assert.strictEqual(gw.attached, true, 'browserAlive:true must read as attached');
    } finally { await close(srv); }
});

test('attached is true when only ok:true is present (the other success signal)', async () => {
    const { srv, port } = await serveHealth({ ok: true, browserAlive: false, wedged: false, outstandingMs: 0 });
    try {
        const gw = await D.probeGateway('127.0.0.1', port);
        assert.strictEqual(gw.attached, true);
    } finally { await close(srv); }
});

test('attached is false for a healthy-but-detached gateway (503 body)', async () => {
    const { srv, port } = await serveHealth({ ok: false, browserAlive: false, wedged: false, outstandingMs: 0 }, 503);
    try {
        const gw = await D.probeGateway('127.0.0.1', port);
        assert.strictEqual(gw.up, true, 'a 503 still proves the listener is up');
        assert.strictEqual(gw.attached, false);
    } finally { await close(srv); }
});

test('a wedged gateway still reports wedged', async () => {
    const { srv, port } = await serveHealth({ ok: true, browserAlive: true, wedged: true, outstandingMs: 1 });
    try {
        const gw = await D.probeGateway('127.0.0.1', port);
        assert.strictEqual(gw.wedged, true);
    } finally { await close(srv); }
});

test('nothing listening is not up', async () => {
    // Bind then immediately close, so the port is almost certainly dead.
    const { srv, port } = await serveHealth({ ok: true });
    await close(srv);
    const gw = await D.probeGateway('127.0.0.1', port);
    assert.strictEqual(gw.up, false);
});

test('non-vacuous: the shipped daemon no longer reads the nonexistent `alive` field', () => {
    // A passing behaviour test proves nothing if the old branch is still first.
    const src = fs.readFileSync(path.join(__dirname, '..', 'cli', 'daemon.js'), 'utf8');
    assert.doesNotMatch(src, /parsed\.alive\b/, 'the dead `parsed.alive` read must be gone');
    assert.match(src, /parsed\.browserAlive/, 'the real field must be read');
});

test('the Doctor screen surfaces the API-token requirement', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'cli', 'index.js'), 'utf8');
    assert.match(src, /name: 'API token'/, 'Doctor must have an API token row');
    assert.match(src, /API_TOKEN/, 'and must name the variable to set');
});
