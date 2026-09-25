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

// The aggregate fronts every lane and supplies each one's auth — the same reason the
// subagent worker posts through it rather than at a lane gateway directly.
function aggregateBase() {
    return process.env.HARNESS_AGGREGATE_URL || 'http://127.0.0.1:8090';
}
// Lane alias per webchat, so a caller can name a lane the aggregate understands.
const GATE_ALIAS = { deepseek: 'ds', gemini: 'gm', chatgpt: 'cg' };

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
            const deadline = Date.now() + wait;
            for (;;) {
                const h = await httpJson('GET', gatewayBase(gate) + '/health', null, 3000);
                if (h.ok && h.status) return asText({ gate: gate.id, started: true, health: h.body });
                if (Date.now() >= deadline) return asText({ gate: gate.id, started: true, answered: false, note: 'gateway up but has not answered /health yet; the browser attaches on the first request' });
                await new Promise((r) => setTimeout(r, 1000));
            }
        }),
    tool('webchat_stop',
        'Stop the gateway for one webchat, or every gateway. Stops the server process only; the browser and its profile (and therefore the login) are left alone.',
        { gate: S('Webchat id. Defaults to the active one.'), all: B('true to stop every gateway.') },
        null,
        async (a) => {
            if (!daemonMod) return asError('daemon module unavailable');
            if (a.all) {
                const out = [];
                for (const g of allGates()) {
                    try { await daemonMod.stopGateway(g.gatewayPort); out.push({ gate: g.id, stopped: true }); }
                    catch (e) { out.push({ gate: g.id, stopped: false, error: e && e.message }); }
                }
                return asText({ stopped: out });
            }
            const gate = activeGate(a.gate);
            if (!gate) return asError('no webchat configured');
            try { await daemonMod.stopGateway(gate.gatewayPort); }
            catch (e) { return asError('could not stop ' + gate.id + ': ' + (e && e.message)); }
            return asText({ gate: gate.id, stopped: true });
        }),
    tool('webchat_restart',
        'Bounce a gateway. This is what makes a config change take effect — the gateway reads its config and code once at boot, so an edited setting or a pulled commit is INERT until a restart.',
        { gate: S('Webchat id. Defaults to the active one.') },
        null,
        async (a) => {
            const gate = activeGate(a.gate);
            if (!gate) return asError('no webchat configured');
            if (!daemonMod) return asError('daemon module unavailable');
            try { await daemonMod.stopGateway(gate.gatewayPort); } catch { /* may not be running */ }
            await new Promise((r) => setTimeout(r, 2000));
            let res;
            try { res = await daemonMod.startGateway({ port: gate.gatewayPort, cdpPort: gate.cdpPort, gate: gate.id }); }
            catch (e) { return asError('restart failed for ' + gate.id + ': ' + (e && e.message)); }
            if (res && res.started === false && res.reason !== 'already running') {
                return asError('restart failed for ' + gate.id + ': ' + (res.reason || 'unknown'));
            }
            // Follow a renumber, and persist it, so the health probe below polls the port
            // the gateway actually bound instead of the one we asked for.
            if (res && res.port && res.port !== gate.gatewayPort) {
                try { if (gatesMod) gatesMod.update(gate.id, { gatewayPort: res.port }); } catch { /* keep going */ }
                gate.gatewayPort = res.port;
            }
            const deadline = Date.now() + 20000;
            for (;;) {
                const h = await httpJson('GET', gatewayBase(gate) + '/health', null, 3000);
                if (h.ok && h.status) return asText({ gate: gate.id, restarted: true, health: h.body });
                if (Date.now() >= deadline) return asText({ gate: gate.id, restarted: true, answered: false });
                await new Promise((r) => setTimeout(r, 1000));
            }
        }),

    // ── observation ──────────────────────────────────────────────────────────
    tool('webchat_health_all',
        'Health of EVERY webchat in one call: reachable, browser attached, in-flight state, send count, wedge state and any cooldown. Cheaper than calling webchat_status per lane, and it is the first thing to run when something looks slow.',
        null, null,
        async () => {
            const out = [];
            for (const g of allGates()) {
                const h = await httpJson('GET', gatewayBase(g) + '/health', null, 4000);
                const m = await httpJson('GET', gatewayBase(g) + '/metrics', null, 4000);
                out.push({
                    gate: g.id,
                    gatewayPort: g.gatewayPort,
                    cdpPort: g.cdpPort,
                    reachable: Boolean(h.ok && h.status),
                    health: (h.body && h.body) || null,
                    metrics: (m.body && m.body) || null,
                    error: h.ok ? null : h.error,
                });
            }
            return asText({ lanes: out });
        }),
    tool('webchat_metrics',
        'The live metrics for one lane: whether a request is in flight and for how long, how many sends have happened, pacing state, and throttle cooldown. This is where requestInFlight lives — it is NOT on /health.',
        { gate: S('Webchat id. Defaults to the active one.') },
        null,
        async (a) => {
            const gate = activeGate(a.gate);
            if (!gate) return asError('no webchat configured');
            const m = await httpJson('GET', gatewayBase(gate) + '/metrics', null, 5000);
            if (!m.ok || !m.status) return asError('metrics unreachable on ' + gatewayBase(gate) + ': ' + (m.error || 'HTTP ' + m.status));
            return asText(m.body);
        }),
    tool('webchat_logs',
        'Read a gateway log. Defaults to the primary gateway log; pass lines to get a tail. Use this to see WHY a request failed — a failed send writes its reason here.',
        { gate: S('Webchat id. Defaults to the active one.'), lines: N('How many trailing lines. Default 80.'), file: S('Read this log file instead (absolute path).') },
        null,
        async (a) => {
            let file = a.file;
            if (!file) {
                const gate = activeGate(a.gate);
                const port = (gate && gate.gatewayPort) || 8081;
                const candidates = [
                    '/tmp/opencode/gw_' + port + '.log',
                    path.join(stateDir(), 'gateway-' + port + '.log'),
                    path.join(stateDir(), 'gateway.log'),
                ];
                file = candidates.find((f) => fs.existsSync(f)) || candidates[0];
            }
            if (!fs.existsSync(file)) return asError('no log at ' + file);
            const n = Math.min(Math.max(Number(a.lines) || 80, 1), 2000);
            const text = fs.readFileSync(file, 'utf8').split('\n');
            return asText({ file, lines: n, tail: text.slice(-n).join('\n') });
        }),
    tool('webchat_probe_lane',
        'Send the smallest possible prompt to a lane and time it, to answer "is this lane actually working right now?". Reports OK, the reply, and the elapsed ms — useful before blaming slowness on a lane.',
        { gate: S('Webchat id. Defaults to the active one.'), timeoutMs: N('Defaults to 120000.') },
        null,
        async (a) => {
            const gate = activeGate(a.gate);
            if (!gate) return asError('no webchat configured');
            const alias = GATE_ALIAS[gate.id] || gate.id;
            const t0 = Date.now();
            const r = await httpJson('POST', aggregateBase() + '/v1/chat/completions', {
                model: alias,
                messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
                max_tokens: 10,
            }, Math.min(Math.max(Number(a.timeoutMs) || 120000, 5000), 600000));
            const ms = Date.now() - t0;
            if (!r.ok) return asText({ gate: gate.id, ok: false, elapsedMs: ms, error: r.error });
            if (r.status !== 200) return asText({ gate: gate.id, ok: false, elapsedMs: ms, status: r.status, body: r.body });
            const content = ((r.body && r.body.choices && r.body.choices[0] && r.body.choices[0].message) || {}).content;
            return asText({ gate: gate.id, ok: true, elapsedMs: ms, reply: content });
        }),

    // ── threads / tabs ───────────────────────────────────────────────────────
    tool('webchat_threads',
        'List the browser tabs a lane can see, with the URL of each. Use this to find which conversation a lane is pinned to before sending to it.',
        { gate: S('Webchat id. Defaults to the active one.') },
        null,
        async (a) => {
            const gate = activeGate(a.gate);
            if (!gate) return asError('no webchat configured');
            const r = await httpJson('GET', 'http://127.0.0.1:' + gate.cdpPort + '/json/list', null, 5000);
            if (!r.ok) return asError('CDP unreachable on ' + gate.cdpPort + ': ' + r.error);
            let tabs = [];
            try { tabs = JSON.parse(r.raw).filter((t) => t.type === 'page').map((t) => ({ title: t.title, url: t.url, id: t.id })); }
            catch { return asError('CDP returned an unparseable target list'); }
            return asText({ gate: gate.id, tabs });
        }),

    // ── memory ───────────────────────────────────────────────────────────────
    tool('webchat_memory_read',
        'Read the memory file the model shares with you. This is persistent context that is injected into the system prompt on every request.',
        null, null,
        async () => {
            const mem = safeRequire('../runtime/memory');
            if (!mem) return asError('memory module unavailable');
            return asText({ file: mem.memoryFile(), contents: mem.readMemory() });
        }),
    tool('webchat_memory_write',
        'Replace the memory file. This is what the model will carry into every future task, so keep it to durable facts rather than a transcript.',
        { contents: S('The new memory contents. An empty string clears it.') },
        ['contents'],
        async (a) => {
            const mem = safeRequire('../runtime/memory');
            if (!mem) return asError('memory module unavailable');
            mem.writeMemory(String(a.contents == null ? '' : a.contents));
            return asText({ file: mem.memoryFile(), chars: mem.readMemory().length });
        }),
    tool('webchat_memory_append',
        'Append one line to the memory file. Convenient for recording a fact while working without rewriting the whole file.',
        { text: S('The line to append.') },
        ['text'],
        async (a) => {
            const mem = safeRequire('../runtime/memory');
            if (!mem) return asError('memory module unavailable');
            const cur = mem.readMemory();
            const next = cur.endsWith('\n') || cur === '' ? cur + String(a.text) + '\n' : cur + '\n' + String(a.text) + '\n';
            mem.writeMemory(next);
            return asText({ file: mem.memoryFile(), chars: next.length, appended: String(a.text) });
        }),

    // ── sandbox / safety ─────────────────────────────────────────────────────
    tool('webchat_sandbox_check',
        'Ask whether a path or a command would be ALLOWED before trying it. Returns the same verdict the tool loop would reach, so you can see a denial instead of triggering one.',
        { path: S('A file path to test.'), command: S('A shell command to test instead.') },
        null,
        async (a) => {
            const sandbox = safeRequire('../tools/sandbox');
            if (!sandbox) return asError('sandbox module unavailable');
            const out = {};
            if (a.path) out.path = { value: a.path, verdict: sandbox.checkPath ? sandbox.checkPath(a.path) : 'checkPath not exported' };
            if (a.command) out.command = { value: a.command, verdict: sandbox.checkCommand(String(a.command)) };
            if (!a.path && !a.command) out.roots = sandbox.roots ? sandbox.roots() : undefined;
            return asText(out);
        }),

    // ── swarm: fan work across every lane ─────────────────────────────────────
    // The point of these is throughput. Asking one lane blocks for the whole answer, so a
    // list of ten tasks costs the sum of ten answers. A swarm spreads the list across every
    // available lane at once and collects the results, which is the difference between
    // "ten minutes" and "one minute".
    tool('webchat_swarm_run',
        'Run many prompts across ALL available lanes in parallel and return every result. Tasks are distributed round-robin over the lanes that are actually reachable. Use this instead of calling webchat_ask in a loop.',
        {
            prompts: { type: 'array', description: 'The list of tasks. Each is an independent prompt.', items: { type: 'string' } },
            gates: { type: 'array', description: 'Which webchats to use. Defaults to every reachable one.', items: { type: 'string' } },
            concurrency: N('How many tasks in flight at once. Defaults to the number of lanes.'),
            timeoutMs: N('Per task, default 300000. Budget generously: a webchat injects a ' +
                         'DELIBERATE 20-80s pause before EVERY send, so a 2-prompt swarm on one ' +
                         'lane takes ~4 minutes of wall-clock. A caller whose own request budget ' +
                         'is shorter than the swarm takes sees "Request timed out" over work that ' +
                         'is still in flight — verified: the same call returns ok=2 in 236s when ' +
                         'run outside the client. For a long swarm, prefer several small calls.'),
        },
        ['prompts'],
        async (a) => {
            const { runSwarm } = safeRequire('../runtime/swarm') || {};
            if (!runSwarm) return asError('swarm runtime unavailable');
            const out = await runSwarm({
                prompts: (a.prompts || []).map(String),
                gates: a.gates,
                concurrency: a.concurrency,
                timeoutMs: a.timeoutMs,
            });
            return asText(out);
        }),
    tool('webchat_swarm_race',
        'Send the SAME prompt to every lane at once and return whichever answers first, plus every other answer as it lands. Useful when you want the fastest reply rather than a specific lane.',
        { prompt: S('The prompt to race.'), gates: { type: 'array', description: 'Which webchats to race. Defaults to every reachable one.', items: { type: 'string' } }, timeoutMs: N('Default 300000.') },
        ['prompt'],
        async (a) => {
            const { raceSwarm } = safeRequire('../runtime/swarm') || {};
            if (!raceSwarm) return asError('swarm runtime unavailable');
            return asText(await raceSwarm({ prompt: String(a.prompt), gates: a.gates, timeoutMs: a.timeoutMs }));
        }),

    // ── local decision model (Laya) ───────────────────────────────────────────
    // Laya is a tiny local judgment model: it answers typed questions (choice / score /
    // noul) in one forward pass with a probability, no text generated. When it is running
    // it is ~2ms and free, so it belongs in front of any call whose only purpose was to get
    // a label or a yes/no back.
    tool('webchat_decide',
        'Ask a local decision model (Laya, if running) for a typed judgment instead of spending a full LLM turn: classify into your own options, score on an ordered scale, or get a calibrated yes/no. Costs nothing and answers in milliseconds. Returns the answer and its probabilities, or says the model is not reachable.',
        {
            state: { type: 'object', description: 'The thing being judged — any JSON object, e.g. {subject, body} or a record.' },
            questions: { type: 'object', description: 'Typed questions keyed by id. Each: {type: "choice"|"score"|"noul", instructions, criteria}. For noul, criteria must be keyed true/false.' },
            endpoint: S('Override the Laya endpoint. Default http://127.0.0.1:8000.'),
        },
        ['state', 'questions'],
        async (a) => {
            const base = String(a.endpoint || process.env.LAYA_ENDPOINT || 'http://127.0.0.1:8000').replace(/\/$/, '');
            const r = await httpJson('POST', base + '/v1/systemone', { state: a.state, questions: a.questions }, 60000);
            if (!r.ok) {
                return asText({
                    available: false,
                    endpoint: base,
                    error: r.error,
                    howToStart: 'laya-serve (pip install "laya[serve]") binds 127.0.0.1:8000. Without it, use webchat_ask or a lane.',
                });
            }
            if (r.status !== 200) return asText({ available: true, status: r.status, body: r.body || r.raw });
            return asText({ available: true, endpoint: base, result: r.body });
        }),

    // ── environment / paths / version ─────────────────────────────────────────
    tool('webchat_paths',
        'Every path this harness resolves: the config file it actually reads, the .env, the workspace root, the state directory, the memory file and the Chrome profile. Run this when a setting "does nothing" — it shows WHICH file is in charge.',
        null, null,
        async () => {
            const out = {};
            try { out.workspaceRoot = PATHS.workspaceRoot(); } catch { /* optional */ }
            if (settingsMod) {
                out.configFile = settingsMod.configFilePath();
                out.envFile = settingsMod.envFilePath();
            }
            out.stateDir = stateDir();
            const mem = safeRequire('../runtime/memory');
            if (mem) out.memoryFile = mem.memoryFile();
            out.chromeProfile = process.env.CHROME_PROFILE || null;
            out.repo = REPO;
            return asText(out);
        }),
    tool('webchat_version',
        'The harness version, Node version, platform, and the git commit this checkout is on — so a report can name exactly what ran.',
        null, null,
        async () => {
            let version = null; let commit = null;
            try { version = require(path.join(REPO, 'package.json')).version; } catch { /* no package.json */ }
            try {
                const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf-8', timeout: 5000 });
                if (r.status === 0) commit = String(r.stdout).trim();
            } catch { /* not a git checkout */ }
            const plat = safeRequire('../core/platform');
            return asText({
                version: version || '(not set)',
                commit: commit || '(unknown)',
                node: process.version,
                platform: plat ? plat.current() : process.platform,
                host: process.platform,
            });
        }),
];

module.exports = { TOOLS };
