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

import fs = require('fs');
import os = require('os');
import path = require('path');
import http = require('http');
import { spawn, spawnSync } from 'child_process';

const REPO = path.join(__dirname, '..', '..');

// ── lazy modules (a broken one must not stop the server from handshaking) ───────
function safeRequire(p: string): unknown {
    try { return require(p); } catch { return null; }
}

function safeRequireTyped<T>(p: string): T | null {
    return safeRequire(p) as T | null;
}

/** The bits of cli/gates.ts used here. */
interface GatesModule {
    read: () => { gates: GateRecord[]; active?: string };
    probe?: (g: GateRecord) => Promise<Record<string, unknown>>;
    update?: (id: string, patch: Record<string, unknown>) => unknown;
    [key: string]: unknown;
}

export interface GateRecord {
    id: string;
    gatewayPort?: number;
    cdpPort?: number;
    label?: string;
    url?: string;
    connected?: boolean;
    [key: string]: unknown;
}

interface SettingsModule {
    saveSetting: (key: string, value: unknown) => { ok: boolean; reason?: string; [key: string]: unknown };
    loadRaw: () => { raw: Record<string, unknown>; file: string };
    resolveAll?: (raw: unknown) => Array<Record<string, unknown>>;
    configFilePath: () => string;
    envFilePath: () => string;
    [key: string]: unknown;
}

interface Report { error?: string; message?: string; reason?: string; [key: string]: unknown }
interface StartGatewayResult { started?: boolean; port?: number; reason?: string; error?: string; [key: string]: unknown }

interface DaemonModule {
    startGateway: (opts: { port?: number; cdpPort?: number; gate?: string }) => Promise<StartGatewayResult>;
    stopGateway: (port?: number) => Promise<Report>;
    launchBrowser: (opts: { cdpPort?: number; profile?: string; url?: string }) => Report | null | undefined;
    [key: string]: unknown;
}

interface HarnessesModule {
    HARNESSES?: HarnessRecord[];
    MODES?: Record<string, unknown>;
    harnessById?: (id: unknown) => HarnessRecord | null | undefined;
    installed?: (h: HarnessRecord) => unknown;
    [key: string]: unknown;
}

interface HarnessRecord {
    id: string;
    label?: string;
    bin?: string;
    note?: string;
    modes?: Record<string, unknown>;
    [key: string]: unknown;
}

interface LaunchModule {
    read?: () => Record<string, unknown>;
    [key: string]: unknown;
}

interface MemoryModule {
    memoryFile: () => string;
    readMemory: () => string;
    writeMemory: (content: unknown) => string;
}

interface SandboxModule {
    roots: string[];
    checkPath: (p: unknown) => unknown;
    checkCommand: (cmd: unknown) => unknown;
}

interface SwarmModule {
    runSwarm: (opts: { prompts: string[]; gates?: string[] | null; concurrency?: number; timeoutMs?: number }) => Promise<unknown>;
    raceSwarm: (opts: { prompt: string; gates?: string[] | null; timeoutMs?: number }) => Promise<unknown>;
}

interface PathsModule {
    workspaceRoot: () => string;
    [key: string]: unknown;
}

const gatesMod = safeRequireTyped<GatesModule>('../cli/gates');
const settingsMod = safeRequireTyped<SettingsModule>('../cli/settings');
const daemonMod = safeRequireTyped<DaemonModule>('../cli/daemon');
const harnessesMod = safeRequireTyped<HarnessesModule>('../cli/harnesses');
const launchMod = safeRequireTyped<LaunchModule>('../cli/launchconfig');
const PATHS = safeRequireTyped<PathsModule>('../core/paths');

export interface ToolReply {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

export type ToolArgs = Record<string, unknown>;

/** A tool argument as a string ('' when absent) — args arrive as untrusted JSON. */
const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** A tool argument as a number, or the fallback when it is not finite. */
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

const S = (description: string): { type: string; description: string } => ({ type: 'string', description });
const B = (description: string): { type: string; description: string } => ({ type: 'boolean', description });
const N = (description: string): { type: string; description: string } => ({ type: 'number', description });

const asText = (s: unknown): ToolReply => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const asError = (s: unknown): ToolReply => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }], isError: true });

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: ToolArgs) => unknown;
}

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

export interface HttpJsonResult {
    ok: boolean;
    status?: number;
    body?: unknown;
    raw?: string;
    error?: string;
}

function httpJson(method: string, url: string, body: unknown, timeoutMs: number = 20000): Promise<HttpJsonResult> {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch { return resolve({ ok: false, error: 'bad url ' + url }); }
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
            timeout: timeoutMs,
            headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c: string) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch { /* a non-JSON body is still an answer */ }
                resolve({ ok: true, status: res.statusCode, body: parsed, raw });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
        req.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

function activeGate(id?: string): GateRecord | null {
    if (!gatesMod) return null;
    const { gates, active } = gatesMod.read();
    if (id) return gates.find((g) => g.id === id) || null;
    return gates.find((g) => g.id === active) || gates[0] || null;
}
function allGates(): GateRecord[] {
    return gatesMod ? gatesMod.read().gates : [];
}
function gatewayBase(gate: GateRecord | null): string {
    return 'http://127.0.0.1:' + ((gate && gate.gatewayPort) || parseInt(process.env.PORT || '8081', 10));
}
function stateDir(): string {
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
            const gate = activeGate(asStr(a.gate));
            if (!gate) return asError('no webchat configured — use webchat_gate_add first');
            if (!daemonMod) return asError('daemon module unavailable');
            const wait = Math.min(Math.max(Number(a.waitMs) || 15000, 1000), 120000);
            let res: StartGatewayResult;
            try {
                res = await daemonMod.startGateway({ port: gate.gatewayPort, cdpPort: gate.cdpPort, gate: gate.id });
            } catch (e) {
                return asError('could not start gateway for ' + gate.id + ': ' + (e as Error).message);
            }
            if (res && res.started === false && res.reason !== 'already running') {
                return asError('could not start gateway for ' + gate.id + ': ' + (res.reason || 'unknown'));
            }
            // startGateway renumbers when the stored port is held by something else. Follow
            // it and PERSIST it, or the /health probe below would poll a port nothing serves
            // and this tool would report started:true / answered:false for a live gateway.
            if (res && res.port && res.port !== gate.gatewayPort) {
                try { if (gatesMod && gatesMod.update) gatesMod.update(gate.id, { gatewayPort: res.port }); } catch { /* keep going on the new port */ }
                gate.gatewayPort = res.port;
            }
            const deadline = Date.now() + wait;
            for (;;) {
                const h = await httpJson('GET', gatewayBase(gate) + '/health', null, 3000);
                if (h.ok && h.status) return asText({ gate: gate.id, started: true, health: h.body });
                if (Date.now() >= deadline) return asText({ gate: gate.id, started: true, answered: false, note: 'gateway up but has not answered /health yet; the browser attaches on the first request' });
                await new Promise<void>((r) => { setTimeout(r, 1000); });
            }
        }),
    tool('webchat_stop',
        'Stop the gateway for one webchat, or every gateway. Stops the server process only; the browser and its profile (and therefore the login) are left alone.',
        { gate: S('Webchat id. Defaults to the active one.'), all: B('true to stop every gateway.') },
        null,
        async (a) => {
            if (!daemonMod) return asError('daemon module unavailable');
            if (a.all === true) {
                const out = [];
                for (const g of allGates()) {
                    try { await daemonMod.stopGateway(g.gatewayPort); out.push({ gate: g.id, stopped: true }); }
                    catch (e) { out.push({ gate: g.id, stopped: false, error: (e as Error).message }); }
                }
                return asText({ stopped: out });
            }
            const gate = activeGate(asStr(a.gate));
            if (!gate) return asError('no webchat configured');
            try { await daemonMod.stopGateway(gate.gatewayPort); }
            catch (e) { return asError('could not stop ' + gate.id + ': ' + (e as Error).message); }
            return asText({ gate: gate.id, stopped: true });
        }),
    tool('webchat_restart',
        'Bounce a gateway. This is what makes a config change take effect — the gateway reads its config and code once at boot, so an edited setting or a pulled commit is INERT until a restart.',
        { gate: S('Webchat id. Defaults to the active one.') },
        null,
        async (a) => {
            const gate = activeGate(asStr(a.gate));
            if (!gate) return asError('no webchat configured');
            if (!daemonMod) return asError('daemon module unavailable');
            try { await daemonMod.stopGateway(gate.gatewayPort); } catch { /* may not be running */ }
            await new Promise<void>((r) => { setTimeout(r, 2000); });
            let res: StartGatewayResult;
            try { res = await daemonMod.startGateway({ port: gate.gatewayPort, cdpPort: gate.cdpPort, gate: gate.id }); }
            catch (e) { return asError('restart failed for ' + gate.id + ': ' + (e as Error).message); }
            if (res && res.started === false && res.reason !== 'already running') {
                return asError('restart failed for ' + gate.id + ': ' + (res.reason || 'unknown'));
            }
            // Follow a renumber, and persist it, so the health probe below polls the port
            // the gateway actually bound instead of the one we asked for.
            if (res && res.port && res.port !== gate.gatewayPort) {
                try { if (gatesMod && gatesMod.update) gatesMod.update(gate.id, { gatewayPort: res.port }); } catch { /* keep going */ }
                gate.gatewayPort = res.port;
