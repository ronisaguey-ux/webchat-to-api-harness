'use strict';
//
// mcp.js — attach ANY MCP server to the harness, with zero new dependencies.
//
// The owner asked: "add the ability to connect ANY mcps/skills to the webchat to
// api harness." Today tools.js holds a fixed TOOL_DEFINITIONS and executeTool only
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

const { spawn } = require('child_process');
const readline = require('readline');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS || '30000', 10);
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

function normalizeSpec(spec) {
    if (spec.url || spec.type === 'remote' || spec.transport === 'http' || spec.transport === 'sse') {
        return { kind: 'http', url: spec.url, headers: spec.headers || {} };
    }
    const command = Array.isArray(spec.command) ? spec.command : [spec.command, ...(spec.args || [])];
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
class StdioTransport {
    constructor(spec) {
        this.spec = spec;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.rl = null;
        this.closed = false;
    }

    async start() {
        const { command, args, env, cwd } = this.spec;
        return new Promise((resolve, reject) => {
            // Close fds 3+ so an MCP child never inherits a parent's IPC channel
            // (node --test runs this file over one — an inherited fd corrupts the
            // runner's stream). Only stdio 0/1/2 are needed for the JSON-RPC line
            // protocol.
            const child = spawn(command, args, {
                env, cwd,
                stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore'],
            });
            this.child = child;
            child.stderr.on('data', () => { /* ignored — a noisy server must not wedge us */ });
            child.on('error', (e) => { this.closed = true; this.rejectAll(e); reject(e); });
            child.on('exit', () => { this.closed = true; this.rejectAll(new Error('mcp server exited')); });
            this.rl = readline.createInterface({ input: child.stdout });
            this.rl.on('line', (line) => this.onMessage(line));
            // Resolve once the process is up. We do not wait for a greeting —
            // JSON-RPC has none; the initialize call below is the real handshake.
            child.once('spawn', () => resolve());
        });
    }

    onMessage(line) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject, timer } = this.pending.get(msg.id);
            clearTimeout(timer);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'mcp error'));
            else resolve(msg.result);
        }
        // notifications (no id) are ignored.
    }

    rejectAll(err) {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this.pending.clear();
    }

    send(method, params) {
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`mcp timeout: ${method}`));
            }, DEFAULT_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            try { this.child.stdin.write(payload + '\n'); } catch (e) { clearTimeout(timer); reject(e); }
        });
    }

    // A notification (no id, no response) — the server must NOT be expected to
    // answer, so nothing is added to `pending` and nothing can hang.
    notify(method, params) {
        try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* ignore */ }
    }

    close() {
        this.closed = true;
        if (this.rl) this.rl.close();
        if (this.child) this.child.kill();
    }
}

// HTTP transport: POST JSON-RPC; accept either a single JSON body or an SSE
// stream carrying `event: message` / `data: <json>`. Handles the session header
// some servers hand back on initialize.
class HttpTransport {
    constructor(spec) {
        this.spec = spec;
        this.sessionId = null;
        this.nextId = 1;
    }

    async start() { /* nothing to pre-open; each request is a POST */ }

    async _post(payload) {
        const headers = {
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
        return JSON.parse(body);
    }

    _parseSse(body) {
        // Pull the last `data:` payload of a message event, which is where the
        // JSON-RPC response rides on streamable-HTTP servers.
        const datas = [];
        for (const line of body.split('\n')) {
            if (line.startsWith('data:')) datas.push(line.slice(5).trim());
        }
        for (const d of datas.reverse()) {
            try { const j = JSON.parse(d); if (j.id !== undefined || j.error) return j; } catch { /* keep looking */ }
        }
        throw new Error('mcp http: no JSON-RPC message in SSE stream');
    }

    send(method, params) {
        return this._post({ jsonrpc: '2.0', id: this.nextId++, method, params })
            .then((res) => {
                if (res && res.error) throw new Error(res.error.message || 'mcp error');
                return res && res.result;
            });
    }

    close() { /* stateless */ }
}

class McpServer {
    constructor(name, spec) {
        this.name = name;
        this.spec = normalizeSpec(spec);
        this.transport = null;
        this.tools = null;
        this.clientInfo = { name: 'webchat-to-api harness', version: '1.0.0' };
    }

    async connect() {
        if (this.transport) return;
        const t = this.spec.kind === 'http' ? new HttpTransport(this.spec) : new StdioTransport(this.spec);
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
        this.serverInfo = (init && init.serverInfo) || {};
    }

    async listTools() {
        await this.connect();
        if (this.tools) return this.tools;
        const res = await this.transport.send('tools/list', {});
        this.tools = (res && res.tools) || [];
        return this.tools;
    }

    async callTool(toolName, args) {
        await this.connect();
        return this.transport.send('tools/call', { name: toolName, arguments: args || {} });
    }

    close() {
        if (this.transport) this.transport.close();
        this.transport = null;
        this.tools = null;
    }
}

// The pool owns discovery and routing. Discover is lazy and fail-open: every
// server is tried once; a failure is logged and that server is dropped from the
// executable set, never retried on the send path.
class McpPool {
    constructor(servers = []) {
        this.servers = [];
        this._serverByName = new Map();
        for (const s of servers) {
            if (!s || !s.name) continue;
            const srv = new McpServer(s.name, s);
            this.servers.push(srv);
            this._serverByName.set(s.name, srv);
        }
        this._discovered = false;
        this._external = [];   // [{ name: '<server>.<tool>', _mcp, def }]
        this._byName = new Map();
    }

    get configured() { return this.servers.length; }

    async discover() {
        if (this._discovered) return this._external;
        this._discovered = true;
        for (const srv of this.servers) {
            try {
                const tools = await srv.listTools();
                for (const tool of tools) {
                    const name = `${srv.name}.${tool.name}`;
                    const def = {
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
                console.log(`⚠️ MCP ${srv.name} unreachable — tools not advertised (${String(e.message).slice(0, 80)})`);
                srv.close();
            }
        }
        return this._external;
    }

    externalDefinitions() {
        return this._external.map(({ _mcp, ...def }) => def);
    }

    has(name) { return this._byName.has(name); }

    async execute(name, args) {
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
            return { success: false, error: `MCP ${name}: ${e.message}` };
        }
    }

    closeAll() {
        for (const srv of this.servers) srv.close();
        this._discovered = false;
        this._external = [];
        this._byName.clear();
    }
}

// A tools/call result is { content: [{type:'text'|'image', text, ...}], isError }.
// Flatten to something the harness's receipt renderer and the model both read.
function normalizeMcpResult(result) {
    if (!result || typeof result !== 'object') return { success: true, content: String(result) };
    if (result.isError) {
        const err = (result.content || []).map((c) => (c && c.text) || '').join('\n');
        return { success: false, error: err || 'mcp tool returned an error' };
    }
    const parts = [];
    for (const block of (result.content || [])) {
        if (!block) continue;
        if (block.type === 'text' && block.text !== undefined) parts.push(String(block.text));
        else if (block.type === 'image') parts.push(`[image: ${block.mimeType || 'image'}]`);
        else parts.push(JSON.stringify(block));
    }
    return { success: true, content: parts.join('\n') || JSON.stringify(result) };
}

module.exports = { McpPool, McpServer, normalizeSpec, normalizeMcpResult };
