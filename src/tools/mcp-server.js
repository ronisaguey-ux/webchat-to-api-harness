#!/usr/bin/env node
'use strict';
//
// mcp-server.js — the webchat harness, exposed as an MCP server.
//
// WHY THIS EXISTS. The gateway is already an API, but it is an API an agent has to be
// TAUGHT: which port, which endpoint, what JSON. An MCP server turns the whole harness
// into tools the agent already knows how to call, so any MCP-capable client (opencode,
// Claude Code, Codex, Claw, anything) can drive it — read and write its config, list
// and connect webchats, call its tools, and put whole tasks through a webchat as a
// subagent.
//
// It is a SEPARATE PROCESS from the gateway on purpose. It speaks MCP on stdio and
// reaches the gateway over HTTP plus the state files on disk, so it can say whether the
// gateway is up rather than assuming it, several agents can attach at once, and a crash
// here can never take the lane down.
//
// ZERO DEPENDENCIES, like the rest of this repo: JSON-RPC 2.0 over newline-delimited
// stdio, Node stdlib only.
//
// Wire it in with:  node mcp-server.js            (the CLI's "Agent access" screen does
// this for you), or see --list for the tool catalogue.
//
const { spawn } = require('child_process');

// ── STDOUT IS THE WIRE. NOTHING ELSE MAY WRITE TO IT. ─────────────────────────
//
// Measured: loading the harness config to answer webchat_gate_add emitted
//   ⚠️ unknown webchat.mode "gemini" — falling back to generic…
// straight into stdout, between two JSON-RPC frames. A client reading that stream
// gets a parse error and the connection is dead — and the cause is a WARNING, which
// is the least likely thing anyone would suspect.
//
// Any module this server loads may console.log. So the redirect happens here, before
// those modules load, and it covers every console method. Diagnostics still reach the
// MCP client's log because stderr is passed through.
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[level] = (...args) => {
        try { process.stderr.write(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch { /* stderr gone */ }
    };
}

const REPO = require('path').join(__dirname, '..', '..');
const PROTOCOL_VERSION = '2024-11-05';

// ── helpers ───────────────────────────────────────────────────────────────────

function httpJson(method, url, body, timeoutMs = 30000) {
    return new Promise((resolve) => {
        const mod = require('http');
        const u = new URL(url);
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = mod.request(
            {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method,
                timeout: timeoutMs,
                headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
            },
            (res) => {
                let raw = '';
                res.setEncoding('utf-8');
                res.on('data', (c) => { raw += c; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(raw); } catch { /* a non-JSON body is still an answer */ }
                    resolve({ ok: true, status: res.statusCode, body: parsed, raw });
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

// Lazy so a broken module cannot stop the server from handshaking — an agent that
// cannot even connect has no way to be told why.
function safeRequire(p) {
    try { return require(p); } catch { return null; }
}

const gatesMod = safeRequire('../../cli/gates');
const harnessesMod = safeRequire('../../cli/harnesses');
const settingsMod = safeRequire('../../cli/settings');
const launchMod = safeRequire('../../cli/launchconfig');
const daemonMod = safeRequire('../../cli/daemon');

// Which webchat an agent means when it does not name one.
//
// The registry's `active` is a UI preference the user set once, and it goes stale: measured
// live, `active` was "gemini" while gemini was SIGNED OUT and `launch.json` pointed at
// deepseek. An agent that omits the gate then drives a lane that cannot answer, and the
// failure reads as the harness being broken rather than the default being wrong.
//
// So the recorded preference is honoured only while it is actually usable. Order:
//   named gate → the recorded active gate IF live → the launch config's gate IF live →
//   any live gate → the recorded active anyway (so a cold box still resolves to something).
//
// The live check is async, so this returns a gate and the caller verifies; `pickGate` below
// is the async form used where a probe is affordable.
function activeGate(id) {
    if (!gatesMod) return null;
    const { gates, active } = gatesMod.read();
    if (id) return gates.find((g) => g.id === id) || null;
    return gates.find((g) => g.id === active) || gates[0] || null;
}

// The same choice, but preferring a gate that is genuinely usable right now.
async function pickGate(id) {
    if (!gatesMod) return null;
    const { gates, active } = gatesMod.read();
    if (id) return gates.find((g) => g.id === id) || null;
    const recorded = gates.find((g) => g.id === active) || null;
    const launch = (launchMod && launchMod.read().gates) || [];
    const preferred = [
        recorded,
        ...launch.map((id2) => gates.find((g) => g.id === id2)).filter(Boolean),
        ...gates,
    ].filter(Boolean);
    for (const g of preferred) {
        const c = await liveConnection(g);
        if (c.connected) return g;
    }
    return recorded || gates[0] || null;
}

// Is this webchat USABLE right now, by evidence rather than by memory?
//
// `g.connected` is a flag written when the user confirms a tab, and nothing clears it — so
// reporting it raw tells an agent "connected" for a browser that was closed hours ago. The
// CLI's dashboard was fixed to probe for exactly this reason; an agent driving the harness
// deserves the same answer, and worse, it acts on what it reads.
//
// gatesMod.live() is the same rule the CLI uses: the browser answers, a tab exists, it has
// a composer, and the page carries no sign-in copy. Falls back to the stored flag only if
// the module cannot perform the check at all, and says which of the two it is.
async function liveConnection(g) {
    if (!g || !gatesMod || typeof gatesMod.liveCached !== 'function') {
        return { connected: Boolean(g && g.connected), verified: false };
    }
    try {
        const state = await gatesMod.liveCached(g, 30000);
        return { connected: Boolean(state.live), verified: true, why: state.live ? null : state.why };
    } catch (e) {
        return { connected: Boolean(g.connected), verified: false, why: (e && e.message) || 'check failed' };
    }
}

function gatewayBase(gate) {
    const port = (gate && gate.gatewayPort) || parseInt(process.env.PORT || '8081', 10);
    return 'http://127.0.0.1:' + port;
}

const asText = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const asError = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }], isError: true });

// Shorthand for a tool's boilerplate.
function tool(name, description, props, required, handler) {
    return {
        name,
        description,
        inputSchema: { type: 'object', properties: props || {}, ...(required ? { required } : {}) },
        handler,
    };
}
const S = (description) => ({ type: 'string', description });
const B = (description) => ({ type: 'boolean', description });

// ── the tools ─────────────────────────────────────────────────────────────────

const TOOLS = [
    // ── discovery ────────────────────────────────────────────────────────────
    tool(
        'webchat_status',
        'Everything about the harness right now: which webchats exist, whether each browser is running, and — for the active one — the live gateway numbers (uptime, sends, in-flight state, latency, pacing, throttle cooldown). Call this first; it tells you whether the rest will work.',
        { gate: S('Webchat id. Defaults to the active one.') },
        null,
        async (a) => {
            if (!gatesMod) return asError('gates module unavailable');
            const { gates, active } = gatesMod.read();
            // The gate the gateway numbers are attached to. NOT `active || gates[0]`: the
            // recorded active gate goes stale (measured: active=gemini while gemini was
            // signed out), so the one row carrying live numbers described a dead lane.
            const defaultGate = await pickGate(a.gate);
            const out = {
                activeGate: active,
                defaultGate: defaultGate ? defaultGate.id : null,
                launch: launchMod ? launchMod.read() : null,
                gates: [],
            };
            for (const g of gates) {
                const probe = await gatesMod.probe(g);
                // Verified live, not the stored flag: an agent acts on what it reads here,
                // and the stored flag outlives the browser it describes.
                const conn = await liveConnection(g);
                const row = {
                    id: g.id, label: g.label, site: g.site, url: g.url,
                    connected: conn.connected, browserRunning: probe.running, tabs: probe.tabs,
                };
                if (!conn.connected && conn.why) row.notConnectedWhy = conn.why;
                if (!conn.verified) row.connectedNote = 'could not verify — showing the recorded flag';
                if (defaultGate && g.id === defaultGate.id) {
                    const h = await httpJson('GET', gatewayBase(g) + '/metrics', null, 4000);
                    row.gateway = h.ok && h.body ? h.body : { reachable: false, error: h.error || 'HTTP ' + h.status };
                    row.default = true;
