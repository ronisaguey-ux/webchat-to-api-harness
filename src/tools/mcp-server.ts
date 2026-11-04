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
import { spawn } from 'child_process';
import http = require('http');

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
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    console[level] = (...args: unknown[]): void => {
        try { process.stderr.write(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch { /* stderr gone */ }
    };
}

const REPO = require('path').join(__dirname, '..', '..');
const PROTOCOL_VERSION = '2024-11-05';

// ── helpers ───────────────────────────────────────────────────────────────────

export interface HttpJsonResult {
    ok: boolean;
    status?: number;
    body?: unknown;
    raw?: string;
    error?: string;
}

function httpJson(method: string, url: string, body: unknown, timeoutMs: number = 30000): Promise<HttpJsonResult> {
    return new Promise((resolve) => {
        const mod = http;
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
                res.on('data', (c: string) => { raw += c; });
                res.on('end', () => {
                    let parsed: unknown = null;
                    try { parsed = JSON.parse(raw) as unknown; } catch { /* a non-JSON body is still an answer */ }
                    resolve({ ok: true, status: res.statusCode, body: parsed, raw });
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

// Lazy so a broken module cannot stop the server from handshaking — an agent that
// cannot even connect has no way to be told why.
function safeRequire(p: string): unknown {
    try { return require(p); } catch { return null; }
}

function safeRequireTyped<T>(p: string): T | null {
    return safeRequire(p) as T | null;
}

/** The slice of src/tools/tools.ts this server calls. */
interface ToolsModule {
    getToolDefinitions: () => Array<{ name: string; description?: string }>;
    getExecutableToolDefinitions: () => Array<{ name: string; description?: string }>;
    isToolAvailable: (name: string) => boolean;
    executeTool: (name: string, args: unknown) => Promise<unknown>;
    TOOL_DEFINITIONS?: Array<{ name: string }>;
}

/** The slice of src/runtime/subagents.ts this server calls. */
interface SubagentsModule {
    spawn: (opts: { prompt: string; gate?: string; label?: unknown; timeoutMs?: unknown }) => {
        id: string;
        state: string;
        [key: string]: unknown;
    };
    list: (opts: { state?: string }) => unknown;
    result: (id: string, waitMs: number) => Promise<Record<string, unknown> | null>;
    cancel: (id: string) => { ok: boolean; reason?: string; [key: string]: unknown };
}

/** The slice of src/core/platform.ts this server calls. */
interface PlatformModule {
    current: () => string;
    hostPlatform: () => string;
    shell: () => { name: string };
    shellHint: () => string;
    defaultRoots: (workspaceRoot?: string | null) => string[];
    normalize: (value: unknown) => string | null;
    setPlatform: (value: unknown) => string;
}

/** One webchat gate as the registry stores it. */
export interface GateRecord {
    id: string;
    gatewayPort: number;
    cdpPort?: number;
    connected?: boolean;
    [key: string]: unknown;
}

export interface GateProbe {
    live?: boolean;
    running?: boolean;
    tabs?: unknown;
    liveTabUrl?: string | null;
    why?: string | null;
    [key: string]: unknown;
}

export interface SiteRecord {
    id: string;
    url?: string;
    label?: string;
    [key: string]: unknown;
}

interface GatesModule {
    read: () => { gates: GateRecord[]; active?: string; default?: string };
    liveCached?: (g: GateRecord, ms: number) => Promise<{ live: boolean; why?: string | null }>;
    probe: (g: GateRecord) => Promise<GateProbe>;
    siteById: (id: unknown) => SiteRecord | null | undefined;
    SITES: SiteRecord[];
    add: (spec: Record<string, unknown>) => GateRecord;
    setActive: (id: string) => unknown;
    update: (id: string, patch: Record<string, unknown>) => unknown;
    remove: (id: unknown) => unknown;
}

export interface ResolvedSetting {
    setting: { path: string; [key: string]: unknown };
    [key: string]: unknown;
}

export interface HarnessRecord {
    id: string;
    label?: string;
    note?: string;
    modes?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface PrepareResult {
    ok?: boolean;
    files?: string[];
    [key: string]: unknown;
}

interface SettingsModule {
    saveSetting: (key: string, value: unknown) => { ok: boolean; reason?: string; shadowed?: boolean; shadowedBy?: string };
    resetSetting?: (key: string) => { ok: boolean; reason?: string; [key: string]: unknown };
    loadRaw: () => { raw: Record<string, unknown>; file: string };
    resolveAll: (raw: unknown) => ResolvedSetting[];
    getPath: (obj: unknown, dotted: string) => unknown;
    setPath: (obj: Record<string, unknown>, dotted: string, value: unknown) => void;
    saveRaw: (raw: unknown, file: string) => void;
}

interface LaunchModule {
    read: () => { gates?: string[]; agent?: Record<string, unknown>; [key: string]: unknown };
    validate: (cfg: unknown, gates: GateRecord[]) => { ok: boolean; problems: string[] };
    write: (cfg: unknown) => { ok: boolean; file?: string; reason?: string; [key: string]: unknown };
    summarize: (cfg: unknown) => Record<string, unknown>;
    autofill: (cfg: unknown, gates: GateRecord[]) => unknown;
    isEnabled?: () => boolean;
}

interface HarnessesModule {
    HARNESSES: HarnessRecord[];
    MODES: Record<string, unknown>;
    installed: (h: HarnessRecord) => unknown;
    harnessById: (id: unknown) => HarnessRecord | null | undefined;
    envFor: (gates: GateRecord[]) => Record<string, string>;
    argvFor: (h: HarnessRecord, mode: unknown, args: string[]) => string[];
    prepareConfigFiles: (h: HarnessRecord, gates: GateRecord[], cwd: string, env: Record<string, string>) => PrepareResult;
}

interface DaemonModule {
    launchBrowser: (opts: { cdpPort?: number; profile?: string; url?: string }) => { error?: string; [key: string]: unknown } | null | undefined;
}

const gatesMod = safeRequire('../cli/gates') as GatesModule | null;
const harnessesMod = safeRequire('../cli/harnesses') as HarnessesModule | null;
const settingsMod = safeRequire('../cli/settings') as SettingsModule | null;
const launchMod = safeRequire('../cli/launchconfig') as LaunchModule | null;
const daemonMod = safeRequire('../cli/daemon') as DaemonModule | null;

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
function activeGate(id?: string): GateRecord | null {
    if (!gatesMod) return null;
    const { gates, active } = gatesMod.read();
    if (id) return gates.find((g) => g.id === id) || null;
    return gates.find((g) => g.id === active) || gates[0] || null;
}

// The same choice, but preferring a gate that is genuinely usable right now.
async function pickGate(id?: string): Promise<GateRecord | null> {
    if (!gatesMod) return null;
    const { gates, active } = gatesMod.read();
    if (id) return gates.find((g) => g.id === id) || null;
    const recorded = gates.find((g) => g.id === active) || null;
    const launch: string[] = (launchMod && launchMod.read().gates) || [];
    const preferred = [
        recorded,
        ...launch.map((id2) => gates.find((g) => g.id === id2)),
        ...gates,
    ].filter((g): g is GateRecord => Boolean(g));
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
async function liveConnection(g: GateRecord | null): Promise<{ connected: boolean; verified: boolean; why?: string | null }> {
    if (!g || !gatesMod || typeof gatesMod.liveCached !== 'function') {
        return { connected: Boolean(g && g.connected), verified: false };
    }
    try {
        const state = await gatesMod.liveCached(g, 30000);
        return { connected: Boolean(state.live), verified: true, why: state.live ? null : state.why };
    } catch (e) {
        return { connected: Boolean(g.connected), verified: false, why: (e as Error).message || 'check failed' };
    }
}

function gatewayBase(gate: GateRecord | null): string {
    const port = (gate && gate.gatewayPort) || parseInt(process.env.PORT || '8081', 10);
    return 'http://127.0.0.1:' + port;
}

export interface ToolReply {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

export type ToolArgs = Record<string, unknown>;

/** A tool argument as a string ('' when absent) — tool args arrive as untrusted JSON. */
const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** A tool argument as a number, falling back to `fallback` when it is not finite. */
const asNum = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && v !== null && v !== '' ? n : fallback;
};
/** Walk a parsed JSON value by key, returning undefined at the first mismatch. */
function pick(value: unknown, ...keys: string[]): unknown {
    let cur: unknown = value;
    for (const k of keys) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
}

const asText = (s: unknown): ToolReply => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const asError = (s: unknown): ToolReply => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }], isError: true });

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: ToolArgs) => unknown;
}

// Shorthand for a tool's boilerplate.
function tool(
    name: string,
    description: string,
    props: Record<string, unknown> | null,
    required: string[] | null,
    handler: (args: ToolArgs) => unknown,
): McpToolDefinition {
    return {
        name,
        description,
        inputSchema: { type: 'object', properties: props || {}, ...(required ? { required } : {}) },
        handler,
    };
}
const S = (description: string): { type: string; description: string } => ({ type: 'string', description });
const B = (description: string): { type: string; description: string } => ({ type: 'boolean', description });

// ── the tools ─────────────────────────────────────────────────────────────────

const TOOLS: McpToolDefinition[] = [
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
            const defaultGate = await pickGate(asStr(a.gate));
            const out: Record<string, unknown> = {
                activeGate: active,
                defaultGate: defaultGate ? defaultGate.id : null,
                launch: launchMod ? launchMod.read() : null,
                gates: [] as Array<Record<string, unknown>>,
            };
            for (const g of gates) {
                const probe = await gatesMod.probe(g);
                // Verified live, not the stored flag: an agent acts on what it reads here,
                // and the stored flag outlives the browser it describes.
                const conn = await liveConnection(g);
                const row: Record<string, unknown> = {
                    id: g.id, label: g.label, site: g.site, url: g.url,
                    connected: conn.connected, browserRunning: probe.running, tabs: probe.tabs,
                };
                if (!conn.connected && conn.why) row.notConnectedWhy = conn.why;
                if (!conn.verified) row.connectedNote = 'could not verify — showing the recorded flag';
                if (defaultGate && g.id === defaultGate.id) {
                    const h = await httpJson('GET', gatewayBase(g) + '/metrics', null, 4000);
                    row.gateway = h.ok && h.body ? h.body : { reachable: false, error: h.error || 'HTTP ' + h.status };
                    row.default = true;
                }
                (out.gates as Array<Record<string, unknown>>).push(row);
            }
            if (!gates.length) out.hint = 'No webchats yet. Call webchat_gate_add, then webchat_gate_launch so the user can log in.';
            return asText(out);
        },
    ),
    tool(
        'webchat_tools_list',
        'List the tools the webchat model itself may call (read_file, run_bash, …) and which are switched off by config.',
        null,
        null,
        async () => {
            // src/tools/tools.ts is not converted yet: reach the source file from dist/.
            const t = safeRequireTyped<ToolsModule>(require('path').join(__dirname, '..', '..', 'src', 'tools', 'tools'));
            if (!t) return asError('tools module unavailable');
            return asText({
                advertised: t.getExecutableToolDefinitions().map((d) => ({ name: d.name, description: d.description })),
                all: t.getToolDefinitions().map((d) => ({ name: d.name, available: t.isToolAvailable(d.name) })),
            });
        },
    ),

    // ── webchats ─────────────────────────────────────────────────────────────
    tool(
        'webchat_gate_add',
        'Create a webchat. Sites: gemini, chatgpt, deepseek, kimi, notegpt, or generic — generic opens an EMPTY browser and the user navigates to any site themselves, which is how an unlisted webchat is supported. Each gets its own Chrome profile and ports so several run at once.',
        { site: S('gemini | chatgpt | deepseek | kimi | notegpt | generic'), label: S('A name to recognise in a list.'), url: S('Override the start URL.') },
        ['site'],
        async (a) => {
            if (!gatesMod) return asError('gates module unavailable');
            const site = gatesMod.siteById(asStr(a.site));
            if (!site) return asError('unknown site "' + a.site + '" — known: ' + gatesMod.SITES.map((x) => x.id).join(', '));
            const { gates } = gatesMod.read();
            const gate = gatesMod.add({ site: site.id, label: asStr(a.label), url: asStr(a.url) || site.url, cdpPort: 9225 + gates.length, gatewayPort: 8081 + gates.length });
            // The gate just created is what the caller means next. Without this, every
            // later tool that omits `gate` falls back to gates[0] — so adding a SECOND
            // webchat and then launching would launch the first one instead.
            gatesMod.setActive(gate.id);
            return asText({ created: gate, next: 'Call webchat_gate_launch so a browser opens for the user to log into.' });
        },
    ),
    tool(
        'webchat_gate_launch',
        "Open a webchat's browser VISIBLY on the user's own screen so they can log in. This is the one step that needs a human: we cannot detect a login (a signed-out page can look signed-in), so the user must confirm it.",
        { gate: S('Webchat id. Defaults to the active one.') },
        null,
        async (a) => {
            if (!gatesMod || !daemonMod) return asError('modules unavailable');
            const gate = await pickGate(asStr(a.gate));
            if (!gate) return asError('no such webchat — call webchat_gate_add first');
            const res = daemonMod.launchBrowser({ cdpPort: gate.cdpPort, profile: asStr(gate.profile), url: asStr(gate.url) || 'about:blank' });
            if (!res || res.error) return asError({ launched: false, error: (res && res.error) || 'launch failed' });
            return asText({
                launched: true, gate: gate.id,
                tell_the_user: 'A browser window is open for "' + gate.label + '". Log in there, then tell me it is done.',
                then: 'Call webchat_gate_confirm to record it as connected.',
            });
        },
    ),
    tool(
        'webchat_gate_confirm',
        'Record that the user has logged in. Only call this AFTER the user says they are signed in — the harness cannot verify a login, so this flag is their statement, not ours.',
        { gate: S('Webchat id. Defaults to the active one.') },
        null,
        async (a) => {
            if (!gatesMod) return asError('gates module unavailable');
            const gate = await pickGate(asStr(a.gate));
            if (!gate) return asError('no such webchat');
            const probe = await gatesMod.probe(gate);
            gatesMod.update(gate.id, { connected: true, liveTabUrl: probe.liveTabUrl || null, connectedAt: new Date().toISOString() });
            gatesMod.setActive(gate.id);
            return asText({
                connected: gate.id, browserRunning: probe.running, tabs: probe.tabs,
                warning: probe.running ? null : 'The browser is not answering on its debug port — the user may have closed it.',
            });
        },
    ),
    tool(
        'webchat_gate_remove',
        'Forget a webchat. Its Chrome profile is left on disk, so re-adding it does not require logging in again.',
        { gate: S('Webchat id.') },
        ['gate'],
        async (a) => {
            if (!gatesMod) return asError('gates module unavailable');
            return asText({ removed: gatesMod.remove(asStr(a.gate)), gate: a.gate });
        },
    ),

    // ── config ───────────────────────────────────────────────────────────────
    tool(
        'webchat_config_list',
        'The harness settings, each with its effective value and WHERE it came from (environment variable, config file, or default). Use this to explain the harness, or before changing anything.',
        null,
        null,
        async () => {
            if (!settingsMod) return asError('settings module unavailable');
            const loaded = settingsMod.loadRaw();
            return asText({
                file: loaded.file,
                settings: settingsMod.resolveAll(loaded.raw).map((r) => ({
                    path: r.setting.path, group: r.group, value: r.value,
                    source: r.source, shadowedBy: r.shadowedBy || null, help: r.setting.help || null,
                })),
            });
        },
    ),
    tool(
        'webchat_config_get',
        'Read one setting by dotted path, e.g. permission.mode or tools.disabled.',
        { path: S('Dotted setting path.') },
        ['path'],
        async (a) => {
            if (!settingsMod) return asError('settings module unavailable');
            const raw = settingsMod.loadRaw().raw;
            const row = settingsMod.resolveAll(raw).find((r) => r.setting.path === asStr(a.path));
            if (!row) return asError('no setting named "' + asStr(a.path) + '"');
            return asText({ path: row.setting.path, value: row.value, source: row.source, shadowedBy: row.shadowedBy || null });
        },
    ),
    tool(
        'webchat_config_set',
        'Change one setting by dotted path. Says whether the write actually took effect — a value shadowed by an environment variable is saved and still ignored, and this reports that instead of claiming success.',
        { path: S('e.g. permission.mode, tools.disabled, systemPrompt.text'), value: { description: 'The new value. An array for list settings.' } },
        ['path', 'value'],
        async (a) => {
            if (!settingsMod) return asError('settings module unavailable');
            const res = settingsMod.saveSetting(asStr(a.path), a.value);
            if (!res.ok) return asError(res.reason);
            if (res.shadowed) {
                return asText({
                    saved: true, effective: false, shadowedBy: res.shadowedBy,
                    note: 'Written to the config file, but ' + res.shadowedBy + ' overrides it. Clear that variable for this to take effect.',
                });
            }
            return asText({ saved: true, effective: true, value: (res as { value?: unknown }).value });
        },
    ),

    // ── putting work through the webchat ─────────────────────────────────────
    tool(
        'webchat_config_reset',
        'Reset one setting to its built-in default. Removes BOTH the config-file value and any environment variable overriding it, and says which it removed — clearing only the file would leave the env var in charge and the setting unchanged, which reads as "reset did nothing".',
        { path: S('Dotted setting path, e.g. permission.mode. Use webchat_config_list to see them.') },
        ['path'],
        async (a) => {
            if (!settingsMod) return asError('settings module unavailable');
            if (typeof settingsMod.resetSetting !== 'function') return asError('this build has no resetSetting');
            const r = settingsMod.resetSetting(asStr(a.path));
            return r.ok ? asText(r) : asError(r.reason);
        },
    ),
    tool(
        'webchat_ask',
        "Send a prompt through a webchat and get the model's answer — this is the 'use a webchat as a subagent' tool. The question goes to the real webchat through the user's own logged-in account, with the harness's tools available to it.",
        {
            prompt: S('What to ask, or the task to perform.'),
            gate: S('Which webchat. Defaults to the active one.'),
            model: S('Override the model id sent to the gateway.'),
            timeoutMs: { type: 'number', description: 'How long to wait. Default 15 min — a webchat can genuinely think for minutes.' },
        },
        ['prompt'],
        async (a) => {
            const gate = await pickGate(asStr(a.gate));
            if (!gate) return asError('no webchat available — call webchat_gate_add then webchat_gate_launch');
            const res = await httpJson('POST', gatewayBase(gate) + '/v1/chat/completions', {
                model: asStr(a.model) || 'webchat/' + gate.id,
                messages: [{ role: 'user', content: String(a.prompt) }],
                stream: false,
            }, asNum(a.timeoutMs, 900000));
            if (!res.ok) return asError('gateway unreachable on ' + gatewayBase(gate) + ': ' + res.error);
            if (res.status !== 200) return asError({ status: res.status, body: res.body || String(res.raw).slice(0, 500) });
            const choices = pick(res.body, 'choices');
            const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
            const replyText = pick(firstChoice, 'message', 'content') ?? null;
            return asText({ gate: gate.id, reply: replyText });
        },
    ),
    tool(
        'webchat_newchat',
        'Reset the webchat conversation. Do this before delegating a NEW task — otherwise the model answers inside whatever conversation was already open. The harness verifies the thread actually emptied and refuses if it did not.',
        { gate: S('Webchat id.') },
        null,
        async (a) => {
            const gate = await pickGate(asStr(a.gate));
            if (!gate) return asError('no webchat available');
            const res = await httpJson('POST', gatewayBase(gate) + '/newchat', {}, 180000);
            if (!res.ok) return asError('gateway unreachable: ' + res.error);
            return asText({ status: res.status, body: res.body || String(res.raw).slice(0, 300) });
        },
    ),
    tool(
        'webchat_handoff',
        'Swap the webchat to a fresh thread AND seed it with a document in one step. Use when a conversation gets long: the model begins the new thread already holding the context you pass.',
        { content: S('What the new thread should start with.'), gate: S('Webchat id.') },
        ['content'],
        async (a) => {
            const gate = await pickGate(asStr(a.gate));
            if (!gate) return asError('no webchat available');
            const res = await httpJson('POST', gatewayBase(gate) + '/handoff', { content: String(a.content) }, 300000);
            if (!res.ok) return asError('gateway unreachable: ' + res.error);
            return asText({ status: res.status, body: res.body || String(res.raw).slice(0, 300) });
        },
    ),
    tool(
        "webchat_call_tool",
        "Run one of the harness's own tools directly, without a model in between. The user's disabled-tool list and every safety gate still apply — this is the same permission the model gets.",
        {
            tool: S('e.g. read_file, list_dir, run_bash, git_status'),
            args: { type: 'object', description: "The tool's arguments." },
        },
        ['tool'],
        async (a) => {
            // src/tools/tools.ts is not converted yet: reach the source file from dist/.
            const t = safeRequireTyped<ToolsModule>(require('path').join(__dirname, '..', '..', 'src', 'tools', 'tools'));
            if (!t) return asError('tools module unavailable');
            if (!t.isToolAvailable(asStr(a.tool))) {
                return asError('"' + a.tool + '" is not available — it is switched off in tools.disabled, or its requirement is unmet.');
            }
            return asText(await t.executeTool(asStr(a.tool), a.args || {}));
        },
    ),

    // ── launching agents ─────────────────────────────────────────────────────
    tool(
        'webchat_harness_list',
        'The agentic harnesses that can be launched against a webchat, which are installed here, and the permission modes available.',
        null,
        null,
        async () => {
            if (!harnessesMod) return asError('harnesses module unavailable');
            return asText({
                harnesses: harnessesMod.HARNESSES.map((h) => ({
                    id: h.id, label: h.label, bin: h.bin,
                    installed: harnessesMod.installed(h), note: h.note, modes: Object.keys(h.modes || {}),
                })),
                modes: Object.values(harnessesMod.MODES),
            });
        },
    ),
    tool(
        'webchat_launch_agent',
        'Point an agentic harness (opencode, Claude Code, Codex, Claw Code, aider, …) at the webchat so the agent uses the webchat as its model. Returns the exact command and environment; with spawn=true it starts it detached for the user.',
        {
            harness: S('e.g. opencode, claude, codex, claw, aider'),
            gate: S('Webchat id. Defaults to the active one.'),
            mode: S('manual | auto | yolo. Default auto.'),
            cwd: S('Working directory for the agent.'),
            spawn: B('Actually start it, detached, instead of only returning the command.'),
            args: { type: 'array', items: { type: 'string' }, description: 'Extra argv for the harness.' },
        },
        ['harness'],
        async (a) => {
            if (!harnessesMod || !daemonMod) return asError('modules unavailable');
            const h = harnessesMod.harnessById(asStr(a.harness));
            if (!h) return asError('unknown harness "' + a.harness + '" — known: ' + harnessesMod.HARNESSES.map((x) => x.id).join(', '));
            const gate = await pickGate(asStr(a.gate));
            if (!gate) return asError('no webchat available');
            const mode = asStr(a.mode) || 'auto';
            if (!harnessesMod.MODES[mode]) return asError('unknown mode "' + mode + '"');
