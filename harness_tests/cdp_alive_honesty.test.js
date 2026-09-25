'use strict';
// cdpAlive() must not call "a port that answers" a browser.
//
// The bug this pins: it returned { up: true, info: null } for ANY 200 response, including a
// body that is not JSON at all. Since cdpTargets() reads /json/list from the same port, a
// non-CDP listener made the two disagree inside one rendered frame — cdpAlive said "browser
// running" while cdpTargets said nothing was there. Same class as a stale connected flag.
//
// The negative cases matter more than the positive one: a guard that rejects everything is an
// outage, so the last test proves a real CDP payload is still accepted.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const D = require(path.join(__dirname, '..', 'cli', 'daemon.js'));

function serve(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
}

test('a non-JSON listener is NOT reported as a browser', async () => {
    const { srv, port } = await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>some unrelated service</body></html>');
    });
    try {
        const r = await D.cdpAlive(port);
        assert.strictEqual(r.up, false, 'HTML on a debug port must not read as a browser');
        assert.match(String(r.error || ''), /not a CDP endpoint/i,
            'the reason must say why, so the user is not left guessing');
    } finally { srv.close(); }
});

test('a JSON body that is not CDP is NOT reported as a browser', async () => {
    // The subtler case: valid JSON, wrong service. This is what a port collision usually looks like.
    const { srv, port } = await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hello: 'i am not chrome' }));
    });
    try {
        const r = await D.cdpAlive(port);
        assert.strictEqual(r.up, false, 'valid JSON is not proof of CDP');
    } finally { srv.close(); }
});

test('a closed port is reported down', async () => {
    const { srv, port } = await serve((req, res) => res.end('x'));
    await new Promise((r) => srv.close(r));           // now nothing is listening there
    const r = await D.cdpAlive(port);
    assert.strictEqual(r.up, false);
});

test('a real CDP payload is still accepted (the guard must not reject everything)', async () => {
    const { srv, port } = await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            Browser: 'Chrome/152.0.0.0',
            'Protocol-Version': '1.3',
            webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/abc',
        }));
    });
    try {
        const r = await D.cdpAlive(port);
        assert.strictEqual(r.up, true, 'a genuine /json/version body must still be accepted');
        assert.strictEqual(r.info.Browser, 'Chrome/152.0.0.0');
    } finally { srv.close(); }
});

test('cdpAlive and cdpTargets agree about a non-CDP port', async () => {
    // The actual user-visible defect: two readers of one port contradicting each other.
    const { srv, port } = await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ unrelated: true }));
    });
    try {
        const alive = await D.cdpAlive(port);
        const targets = await D.cdpTargets(port);
        assert.strictEqual(alive.up, targets.ok,
            'the status line and the tab list must not disagree about the same port');
    } finally { srv.close(); }
});
