'use strict';
//
// mcp.ts — attach ANY MCP server to the harness, with zero new dependencies.
//
// The owner asked: "add the ability to connect ANY mcps/skills to the webchat to
// api harness." Today tools.ts holds a fixed TOOL_DEFINITIONS and executeTool only
// sees those. This module adds a configurable external source:
//
//   harness.config.json -> "mcp": { "servers": [ { "name", "command", "args",
//                                                     "url", "headers" } ] }
//
// Each server is spoken to over the Model Context Protocol (JSON-RPC 2.0) and its
// tools are discovered (tools/list) and merged into the list the model is offered,
// then executeTool calls are routed to the right server. The protocol is the same
// one the owner's tool-call-compactor speaks (/home/roni/Roni_workspace/tool-call-
// compactor, src/upstream.js) — re-read there for the handshake, but implemented
// here on Node's stdlib so the harness keeps its "no new dependency" rule.
//
// Transport: stdio (spawn command+args, newline-delimited JSON-RPC) and HTTP
// (POST JSON-RPC, response parsed as either one JSON body or an SSE stream).
//
// FAIL-OPEN, always: an unreachable server must never break a send, and its tools
// must not be advertised (they cannot be executed — A1's rule). A server that dies
// mid-session simply stops answering; the model gets a clear error and moves on.

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import readline = require('readline');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS || '30000', 10);
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

/** A server entry as it appears in harness.config.json -> mcp.servers[n]. */
export interface McpServerSpec {
    name?: string;
    command?: string | string[];
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string | undefined>;
    environment?: Record<string, string | undefined>;
    cwd?: string;
    type?: string;
    transport?: string;
}

export interface StdioSpec {
    kind: 'stdio';
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd?: string;
}

export interface HttpSpec {
    kind: 'http';
    url: string;
    headers: Record<string, string>;
}

export type TransportSpec = StdioSpec | HttpSpec;

/** A tool as the MCP server advertises it (tools/list). */
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
}

/** A tool as the gateway advertises it to the model, tagged for routing. */
export interface McpExternalTool {
    name: string;
    category: string;
    description: string;
    parameters: unknown;
    _mcp: { server: string; tool: string };
}

export interface McpToolResult {
    success: boolean;
    content?: string;
    error?: string;
}

interface JsonRpcError {
    message?: string;
}

interface JsonRpcMessage {
    id?: number | string;
    error?: JsonRpcError;
    result?: unknown;
}

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
}

/** What both transports expose; the pool only needs this much. */
export interface McpTransport {
    start: () => Promise<void>;
    send: (method: string, params: unknown) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
    close: () => void;
}

function normalizeSpec(spec: McpServerSpec): TransportSpec {
    if (spec.url || spec.type === 'remote' || spec.transport === 'http' || spec.transport === 'sse') {
        return { kind: 'http', url: String(spec.url), headers: spec.headers || {} };
    }
    const command: string[] = Array.isArray(spec.command) ? spec.command : [spec.command, ...(spec.args || [])] as string[];
    if (!command[0]) throw new Error('mcp server spec has neither url nor command');
    return {
        kind: 'stdio',
        command: command[0],
        args: command.slice(1),
        env: { ...process.env, ...(spec.environment || spec.env || {}) },
        cwd: spec.cwd,
    };
}

// JSON-RPC over a stdio child: one newline-delimited JSON object per line.
class StdioTransport implements McpTransport {
    spec: StdioSpec;
    child: ChildProcess | null;
    nextId: number;
    pending: Map<number | string, PendingCall>;
    rl: readline.Interface | null;
    closed: boolean;

    constructor(spec: StdioSpec) {
        this.spec = spec;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.rl = null;
        this.closed = false;
    }

    async start(): Promise<void> {
        const { command, args, env, cwd } = this.spec;
        return new Promise<void>((resolve, reject) => {
            // Close fds 3+ so an MCP child never inherits a parent's IPC channel
            // (node --test runs this file over one — an inherited fd corrupts the
            // runner's stream). Only stdio 0/1/2 are needed for the JSON-RPC line
            // protocol.
            const child = spawn(command, args, {
                env, cwd,
                stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore'],
            });
            this.child = child;
            if (child.stderr) child.stderr.on('data', () => { /* ignored — a noisy server must not wedge us */ });
            child.on('error', (e: Error) => { this.closed = true; this.rejectAll(e); reject(e); });
            child.on('exit', () => { this.closed = true; this.rejectAll(new Error('mcp server exited')); });
            this.rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
            this.rl.on('line', (line: string) => this.onMessage(line));
            // Resolve once the process is up. We do not wait for a greeting —
            // JSON-RPC has none; the initialize call below is the real handshake.
            child.once('spawn', () => resolve());
        });
    }

    onMessage(line: string): void {
        let msg: JsonRpcMessage | null = null;
        try { msg = JSON.parse(line) as JsonRpcMessage; } catch { return; }
        if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
            const call = this.pending.get(msg.id) as PendingCall;
            clearTimeout(call.timer);
            this.pending.delete(msg.id);
            if (msg.error) call.reject(new Error(msg.error.message || 'mcp error'));
            else call.resolve(msg.result);
        }
        // notifications (no id) are ignored.
    }

    rejectAll(err: Error): void {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this.pending.clear();
    }

    send(method: string, params: unknown): Promise<unknown> {
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`mcp timeout: ${method}`));
            }, DEFAULT_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            try {
                (this.child as ChildProcess).stdin?.write(payload + '\n');
            } catch (e) {
                clearTimeout(timer);
                reject(e as Error);
            }
        });
    }

    // A notification (no id, no response) — the server must NOT be expected to
    // answer, so nothing is added to `pending` and nothing can hang.
    notify(method: string, params: unknown): void {
        try {
            (this.child as ChildProcess).stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
        } catch { /* ignore */ }
    }

    close(): void {
        this.closed = true;
        if (this.rl) this.rl.close();
        if (this.child) this.child.kill();
    }
}

// HTTP transport: POST JSON-RPC; accept either a single JSON body or an SSE
// stream carrying `event: message` / `data: <json>`. Handles the session header
// some servers hand back on initialize.
class HttpTransport implements McpTransport {
    spec: HttpSpec;
    sessionId: string | null;
    nextId: number;

    constructor(spec: HttpSpec) {
        this.spec = spec;
        this.sessionId = null;
        this.nextId = 1;
    }

    async start(): Promise<void> { /* nothing to pre-open; each request is a POST */ }

    async _post(payload: unknown): Promise<unknown> {
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(this.spec.headers || {}),
        };
        if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
        const resp = await fetch(this.spec.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        const sid = resp.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;
        const ctype = resp.headers.get('content-type') || '';
        const body = await resp.text();
        if (ctype.includes('text/event-stream')) return this._parseSse(body);
        if (!resp.ok) throw new Error(`mcp http ${resp.status}: ${body.slice(0, 200)}`);
        return JSON.parse(body) as unknown;
    }

    _parseSse(body: string): unknown {
        // Pull the last `data:` payload of a message event, which is where the
        // JSON-RPC response rides on streamable-HTTP servers.
        const datas: string[] = [];
        for (const line of body.split('\n')) {
            if (line.startsWith('data:')) datas.push(line.slice(5).trim());
        }
        for (const d of datas.reverse()) {
            try {
                const j = JSON.parse(d) as JsonRpcMessage;
                if (j.id !== undefined || j.error) return j;
            } catch { /* keep looking */ }
        }
        throw new Error('mcp http: no JSON-RPC message in SSE stream');
    }

    send(method: string, params: unknown): Promise<unknown> {
        return this._post({ jsonrpc: '2.0', id: this.nextId++, method, params })
            .then((res) => {
                const msg = res as JsonRpcMessage | null;
                if (msg && msg.error) throw new Error(msg.error.message || 'mcp error');
                return msg && msg.result;
            });
    }

    notify(): void { /* stateless: no notification channel */ }

    close(): void { /* stateless */ }
}

class McpServer {
    name: string;
    spec: TransportSpec;
    transport: McpTransport | null;
    tools: McpToolInfo[] | null;
    clientInfo: { name: string; version: string };
    serverInfo: Record<string, unknown>;

    constructor(name: string, spec: McpServerSpec) {
        this.name = name;
        this.spec = normalizeSpec(spec);
        this.transport = null;
        this.tools = null;
        this.clientInfo = { name: 'webchat-to-api harness', version: '1.0.0' };
        this.serverInfo = {};
    }

    async connect(): Promise<void> {
        if (this.transport) return;
        const t: McpTransport = this.spec.kind === 'http' ? new HttpTransport(this.spec) : new StdioTransport(this.spec);
        await t.start();
        this.transport = t;
        const init = await t.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: this.clientInfo,
        });
        // The handshake is two-way: server may reject our protocolVersion, but a
        // real server answers initialize with its own capabilities. Send the
        // initialized notification (no id, no response expected).
        try { t.notify('notifications/initialized', {}); } catch { /* best-effort */ }
        const initRecord = init && typeof init === 'object' ? init as Record<string, unknown> : {};
        this.serverInfo = (initRecord.serverInfo && typeof initRecord.serverInfo === 'object')
            ? initRecord.serverInfo as Record<string, unknown>
            : {};
    }

    async listTools(): Promise<McpToolInfo[]> {
        await this.connect();
        if (this.tools) return this.tools;
        const res = await (this.transport as McpTransport).send('tools/list', {});
        const record = res && typeof res === 'object' ? res as Record<string, unknown> : {};
        this.tools = Array.isArray(record.tools) ? record.tools as McpToolInfo[] : [];
        return this.tools;
    }

    async callTool(toolName: string, args: unknown): Promise<unknown> {
        await this.connect();
        return (this.transport as McpTransport).send('tools/call', { name: toolName, arguments: args || {} });
    }

    close(): void {
        if (this.transport) this.transport.close();
        this.transport = null;
        this.tools = null;
    }
}

// The pool owns discovery and routing. Discover is lazy and fail-open: every
// server is tried once; a failure is logged and that server is dropped from the
// executable set, never retried on the send path.
class McpPool {
    servers: McpServer[];
    _serverByName: Map<string, McpServer>;
    _listed: Set<string>;
    _external: McpExternalTool[];
    _byName: Map<string, McpExternalTool>;

    constructor(servers: McpServerSpec[] = []) {
        this.servers = [];
        this._serverByName = new Map();
        // Per-server, not one global latch: a server is listed once, and a server that
        // arrives later (config edited while the gateway runs) is listed on its own.
        this._listed = new Set();
        this._external = [];   // [{ name: '<server>.<tool>', _mcp, def }]
        this._byName = new Map();
        this._addServers(servers);
    }

    get configured(): number { return this.servers.length; }

    _addServers(servers: McpServerSpec[] = []): McpServer[] {
        const added: McpServer[] = [];
        for (const s of servers) {
            if (!s || !s.name || this._serverByName.has(s.name)) continue;
            const srv = new McpServer(s.name, s);
            this.servers.push(srv);
            this._serverByName.set(s.name, srv);
            added.push(srv);
        }
        return added;
    }

    // Drop a server that is no longer in the config, along with every tool it published.
    // Leaving it advertised would offer the model a tool whose server is gone.
    _dropServer(srv: McpServer): void {
        this.servers = this.servers.filter((s) => s !== srv);
        this._serverByName.delete(srv.name);
        this._listed.delete(srv.name);
        const prefix = `${srv.name}.`;
        this._external = this._external.filter((d) => !String(d.name).startsWith(prefix));
        for (const k of [...this._byName.keys()]) {
            if (k.startsWith(prefix)) this._byName.delete(k);
        }
        try { srv.close(); } catch { /* already gone */ }
    }

    async discover(): Promise<McpExternalTool[]> {
        await this._listServers(this.servers);
        return this._external;
    }

    // 2026-09-26 (owner): "any new mcps added should automatically show up".
    // Discovery used to run once and latch for the life of the process, so an MCP added
    // to the config while the gateway was running did not exist until a restart — which
    // reads as the feature being broken. sync() reconciles the pool against the config
    // it is handed and lists only what is new, so a new entry appears on the next
    // request. Returns how many servers were added or removed, so a caller can tell
    // "nothing changed" from "the set moved" without re-serialising every definition.
    async sync(servers: McpServerSpec[] = []): Promise<number> {
        const wanted = new Set<string>();
        for (const s of servers) if (s && s.name) wanted.add(s.name);

        let changes = 0;
        for (const srv of this.servers.filter((s) => !wanted.has(s.name))) {
            this._dropServer(srv);
            changes++;
        }
        const added = this._addServers(servers);
        if (added.length) {
            await this._listServers(added);
            changes += added.length;
        }
        return changes;
    }

    async _listServers(list: McpServer[]): Promise<McpExternalTool[]> {
        for (const srv of list) {
            if (this._listed.has(srv.name)) continue;
            this._listed.add(srv.name);
            try {
                const tools = await srv.listTools();
                for (const tool of tools) {
                    const name = `${srv.name}.${tool.name}`;
                    const def: McpExternalTool = {
                        name,
                        category: 'mcp',
                        description: `[MCP ${srv.name}] ${tool.description || tool.name}`,
                        parameters: tool.inputSchema || { type: 'object', properties: {} },
                        // Marker so executeTool knows to route to the pool.
                        _mcp: { server: srv.name, tool: tool.name },
                    };
                    this._external.push(def);
                    this._byName.set(name, def);
                }
                console.log(`🔌 MCP ${srv.name}: ${tools.length} tool(s) discovered`);
            } catch (e) {
                console.log(`⚠️ MCP ${srv.name} unreachable — tools not advertised (${String((e as Error).message).slice(0, 80)})`);
                srv.close();
            }
        }
        return this._external;
    }

    externalDefinitions(): Array<Omit<McpExternalTool, '_mcp'>> {
        return this._external.map(({ _mcp, ...def }) => def);
    }

    has(name: string): boolean { return this._byName.has(name); }

    async execute(name: string, args: unknown): Promise<McpToolResult> {
        const def = this._byName.get(name);
        if (!def) return { success: false, error: `unknown MCP tool: ${name}` };
        const srv = this._serverByName.get(def._mcp.server);
        if (!srv) return { success: false, error: `unknown MCP server: ${def._mcp.server}` };
        try {
            const result = await srv.callTool(def._mcp.tool, args);
            // Normalise the MCP result (content blocks / structuredContent) into
            // the harness's plain-object shape so formatToolResultView can render it.
            return normalizeMcpResult(result);
        } catch (e) {
            return { success: false, error: `MCP ${name}: ${(e as Error).message}` };
        }
    }

    closeAll(): void {
        for (const srv of this.servers) srv.close();
        this.servers = [];
        this._serverByName.clear();
        this._listed.clear();
        this._external = [];
        this._byName.clear();
    }
}

// A tools/call result is { content: [{type:'text'|'image', text, ...}], isError }.
// Flatten to something the harness's receipt renderer and the model both read.
function normalizeMcpResult(result: unknown): McpToolResult {
    if (!result || typeof result !== 'object') return { success: true, content: String(result) };
    const record = result as Record<string, unknown>;
    const content = Array.isArray(record.content) ? record.content : [];
    if (record.isError) {
        const err = content.map((c) => {
            const block = c && typeof c === 'object' ? c as Record<string, unknown> : {};
            return block.text ? String(block.text) : '';
        }).join('\n');
        return { success: false, error: err || 'mcp tool returned an error' };
    }
    const parts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && b.text !== undefined) parts.push(String(b.text));
        else if (b.type === 'image') parts.push(`[image: ${b.mimeType || 'image'}]`);
        else parts.push(JSON.stringify(block));
    }
    return { success: true, content: parts.join('\n') || JSON.stringify(result) };
}

export = { McpPool, McpServer, normalizeSpec, normalizeMcpResult };
