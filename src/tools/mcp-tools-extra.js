'use strict';
//
// mcp-tools-extra.js — the operational half of the MCP surface.
//
// Why a second file: the core tools in mcp-server.js are the *interaction* surface (ask,
// configure, spawn). These are the *operation* surface — lifecycle, logs, health, memory,
// sandbox probing, and the swarm runners that fan work across every lane at once. Keeping
// them apart means the core file stays readable and this one can grow with the deployment.
//
// Every tool here follows the same rule as the core set: it reports what actually happened.
// A tool that cannot do its job returns isError with the reason rather than a success shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');

// ── lazy modules (a broken one must not stop the server from handshaking) ───────
function safeRequire(p) {
    try { return require(p); } catch { return null; }
}
const gatesMod = safeRequire('../../cli/gates');
const settingsMod = safeRequire('../../cli/settings');
const daemonMod = safeRequire('../../cli/daemon');
const harnessesMod = safeRequire('../../cli/harnesses');
const launchMod = safeRequire('../../cli/launchconfig');
const PATHS = safeRequire('../core/paths');

const S = (description) => ({ type: 'string', description });
const B = (description) => ({ type: 'boolean', description });
const N = (description) => ({ type: 'number', description });

const asText = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const asError = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }], isError: true });

function tool(name, description, props, required, handler) {
    return {
        name,
        description,
        inputSchema: { type: 'object', properties: props || {}, ...(required ? { required } : {}) },
        handler,
    };
}

function httpJson(method, url, body, timeoutMs = 20000) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad url ' + url }); }
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
            timeout: timeoutMs,
            headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch { /* a non-JSON body is still an answer */ }
                resolve({ ok: true, status: res.statusCode, body: parsed, raw });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

function activeGate(id) {
    if (!gatesMod) return null;
    const { gates, active } = gatesMod.read();
    if (id) return gates.find((g) => g.id === id) || null;
    return gates.find((g) => g.id === active) || gates[0] || null;
}
function allGates() {
    return gatesMod ? gatesMod.read().gates : [];
}
function gatewayBase(gate) {
    return 'http://127.0.0.1:' + ((gate && gate.gatewayPort) || parseInt(process.env.PORT || '8081', 10));
}
function stateDir() {
    const d = PATHS ? path.join(PATHS.workspaceRoot(), 'state') : path.join(REPO, 'state');
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ }
    return d;
}

// The daemon (cli/daemon.js) writes every runtime file — gateway logs, pids and the
// Chrome profile — under ITS state dir, and that is not the same place as stateDir()
// above: it is <repo>/.webchat unless WEBCHAT_STATE_DIR overrides it. Mirror the rule
// here, or a log reader looks in a directory nothing writes to and reports a stale
// file as though it were live.
function runtimeStateDir() {
    return process.env.WEBCHAT_STATE_DIR
        ? path.resolve(process.env.WEBCHAT_STATE_DIR)
        : path.join(REPO, '.webchat');
}

// The aggregate fronts every lane and supplies each one's auth — the same reason the
// subagent worker posts through it rather than at a lane gateway directly.
function aggregateBase() {
    return process.env.HARNESS_AGGREGATE_URL || 'http://127.0.0.1:8090';
}
// Lane alias per webchat, so a caller can name a lane the aggregate understands.
// The aggregate resolves model ids through its registry; the short ids (ds/gm/cg) are not
// in it. Use the qualified webchat/<gate> form, which parses on the hub and on a lane.


const TOOLS = [

    // ── lifecycle ────────────────────────────────────────────────────────────
    tool('webchat_start',
        'Start the gateway for a webchat that is not running. Returns once it answers or reports why it could not. Use webchat_stop to bring it down, webchat_restart to bounce it.',
        { gate: S('Webchat id. Defaults to the active one.'), waitMs: N('How long to wait for it to answer. Default 15000.') },
        null,
        async (a) => {
            const gate = activeGate(a.gate);
            if (!gate) return asError('no webchat configured — use webchat_gate_add first');
            if (!daemonMod) return asError('daemon module unavailable');
            const wait = Math.min(Math.max(Number(a.waitMs) || 15000, 1000), 120000);
            let res;
            try {
                res = await daemonMod.startGateway({ port: gate.gatewayPort, cdpPort: gate.cdpPort, gate: gate.id });
            } catch (e) {
                return asError('could not start gateway for ' + gate.id + ': ' + (e && e.message));
            }
            if (res && res.started === false && res.reason !== 'already running') {
                return asError('could not start gateway for ' + gate.id + ': ' + (res.reason || 'unknown'));
            }
            // startGateway renumbers when the stored port is held by something else. Follow
            // it and PERSIST it, or the /health probe below would poll a port nothing serves
            // and this tool would report started:true / answered:false for a live gateway.
            if (res && res.port && res.port !== gate.gatewayPort) {
                try { if (gatesMod) gatesMod.update(gate.id, { gatewayPort: res.port }); } catch { /* keep going on the new port */ }
                gate.gatewayPort = res.port;
            }
