'use strict';
// The dashboard's Status panel must render while the browser IS running. Measured
// 2026-09-26 with a live browser on the CDP port: frame() read `snap.cdp.pages.length`,
// but cdpAlive() never returns `pages`, so every frame threw a TypeError — which A.menu
// swallows by design — and the panel (gateway / browser / webchat, the env-shadowing
// warning) was never drawn at all. Only the menu showed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-dash-'));

// A port nothing listens on: bind, read it, close.
function deadPort() {
    return new Promise((resolve) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

// A browser's CDP endpoint, as far as the dashboard asks: version, and two tabs.
function fakeCdp() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/json/version') return res.end(JSON.stringify({ Browser: 'Chrome/1' }));
            if (req.url === '/json/list') return res.end(JSON.stringify([
                { type: 'page', url: 'https://chat.example/a' },
                { type: 'page', url: 'https://chat.example/b' },
                { type: 'service_worker', url: 'x' },
            ]));
            res.statusCode = 404; res.end('{}');
        }).listen(0, '127.0.0.1', () => resolve(srv));
    });
}

function load(gwPort, cdpPort) {
    const cfg = path.join(TMP, 'harness.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ platform: 'linux', server: { port: gwPort } }));
    process.env.HARNESS_CONFIG = cfg;
    process.env.WEBCHAT_STATE_DIR = path.join(TMP, 'state');
    process.env.CDP_PORT = String(cdpPort);
    process.env.MAX_TOOL_ROUNDS = '8';   // one env override, for the shadowing warning
    return {
        idx: require(path.join(REPO, 'cli', 'index.js')),
        A: require(path.join(REPO, 'cli', 'ansi.js')),
    };
}

async function panelOf(idx, A) {
    let panel = null;
    let thrown = null;
    const realMenu = A.menu;
    A.menu = async (items, opts) => {
        try { panel = opts.onTick(); } catch (e) { thrown = e; }
        throw new A.QuitError();
    };
    try {
        await idx.screenDashboard().catch((e) => { if (!(e instanceof A.QuitError)) throw e; });
    } finally { A.menu = realMenu; }
    assert.strictEqual(thrown, null, 'frame() threw: ' + (thrown && thrown.message));
    return panel.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
}

test('the status panel renders with the browser running', async () => {
    const cdp = await fakeCdp();
    try {
        const { idx, A } = load(await deadPort(), cdp.address().port);
        const text = await panelOf(idx, A);
        assert.match(text, /gateway\s+stopped/);
        assert.match(text, /browser\s+running, CDP :\d+\s+2 tab\(s\)/);
        assert.match(text, /come from an environment variable/);
    } finally { cdp.close(); }
});

test('and with no browser at all', async () => {
    const { idx, A } = load(await deadPort(), await deadPort());
    const text = await panelOf(idx, A);
    assert.match(text, /browser\s+not running/);
});
