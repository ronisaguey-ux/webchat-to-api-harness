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
