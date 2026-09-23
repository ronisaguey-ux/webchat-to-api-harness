'use strict';
// Feature tests for the 09-22 capabilities (Parts A + B).
//
// Each of these pins a real defect or a real new capability against the REAL
// implementation, not a re-implementation:
//
//   A1 — the harness advertised tools it could not execute (search_web with no
//        DEEPSEEK_API_KEY, run_bash with the gate off). The model tried them,
//        hit a hard error, and looped. The executable set must be derived from
//        what is actually available.
//   B1 — search_web keyless: with native search ON it guides the model to use
//        the webchat's own search; with no key and no native search it returns
//        ONE clear message instead of a hard "disabled" error.
//   B3 — tool-result compaction (head+tail, never touch an error).
//   B4 — a memory file the model reads/edits, bounded.
//   B2 — attach any MCP server, fail-open.
//
// `config` and `tools` are loaded once and their exported object is MUTATED per
// test — the `available()` predicates and handlers read config/process.env at
// call time, so this exercises the exact code the server runs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../config');
const tools = require('../tools');
const compactor = require('../compactor');
const memory = require('../memory');
const { McpPool, normalizeSpec, normalizeMcpResult } = require('../mcp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-features-'));

// ── A1: the executable set is derived from availability ────────────────────

test('A1: search_web is dropped when no key and no native search', () => {
    const saved = { key: process.env.DEEPSEEK_API_KEY, ws: config.webSearchAvailable };
    try {
        delete process.env.DEEPSEEK_API_KEY;
        config.webSearchAvailable = false;
        const names = tools.getExecutableToolDefinitions().map((t) => t.name);
        assert.ok(!names.includes('search_web'), 'search_web must not be advertised');
        assert.ok(names.includes('read_file'), 'read_file stays (always available)');
    } finally {
        if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.key;
        config.webSearchAvailable = saved.ws;
    }
});

test('A1: search_web is advertised when a key is present', () => {
    const saved = { key: process.env.DEEPSEEK_API_KEY, ws: config.webSearchAvailable };
    try {
        process.env.DEEPSEEK_API_KEY = 'test-key';
        config.webSearchAvailable = true;
        const names = tools.getExecutableToolDefinitions().map((t) => t.name);
        assert.ok(names.includes('search_web'), 'search_web must be advertised when a key exists');
    } finally {
        if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.key;
        config.webSearchAvailable = saved.ws;
    }
});

test('A1: run_bash is dropped when the bash gate is off', () => {
    const saved = config.bashAllowed;
    try {
        config.bashAllowed = false;
        assert.ok(!tools.getExecutableToolDefinitions().map((t) => t.name).includes('run_bash'));
        config.bashAllowed = true;
        assert.ok(tools.getExecutableToolDefinitions().map((t) => t.name).includes('run_bash'));
    } finally {
        config.bashAllowed = saved;
    }
});

// ── B1: search_web no longer hard-requires a key ───────────────────────────

test('B1: with native search on and no key, search_web guides instead of erroring', async () => {
    const saved = { key: process.env.DEEPSEEK_API_KEY, ns: config.nativeSearch, ws: config.webSearchAvailable };
    try {
        delete process.env.DEEPSEEK_API_KEY;
        config.nativeSearch = true;
        config.webSearchAvailable = true; // native search ON ⇒ search_web is available (A1)
        const r = await tools.executeTool('search_web', { query: 'anything' });
        assert.strictEqual(r.success, true, 'native search lane must not report a hard failure');
        assert.strictEqual(r.native, true);
    } finally {
        if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.key;
        config.nativeSearch = saved.ns;
        config.webSearchAvailable = saved.ws;
    }
});

test('B1: with no key and no native search, search_web returns ONE clear message', async () => {
    const saved = { key: process.env.DEEPSEEK_API_KEY, ns: config.nativeSearch };
    try {
        delete process.env.DEEPSEEK_API_KEY;
        config.nativeSearch = false;
        const r = await tools.executeTool('search_web', { query: 'anything' });
        assert.strictEqual(r.success, false);
        assert.match(r.error, /not available/, 'the message must name the lane as unavailable, not "disabled"');
    } finally {
        if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.key;
        config.nativeSearch = saved.ns;
    }
});

// ── B3: compactor ──────────────────────────────────────────────────────────

test('B3: compaction trims a long text field to head+tail with a marker', () => {
    const long = 'a'.repeat(5000) + 'NEEDLE-AT-TAIL';
    const { result, compacted } = compactor.compactResult({ success: true, content: long }, { maxText: 1000 });
    assert.strictEqual(compacted, true);
    assert.ok(result.content.length <= 1100, 'content is bounded');
    assert.match(result.content, /dropped/, 'the marker names what was dropped');
    assert.ok(result.content.includes('NEEDLE-AT-TAIL'), 'the tail is kept — never head-only truncation');
});

test('B3: an error result is never touched', () => {
    const err = { success: false, error: 'boom ' + 'x'.repeat(5000) };
    const { result, compacted } = compactor.compactResult(err, { maxText: 100 });
    assert.strictEqual(compacted, false);
    assert.strictEqual(result.error, err.error, 'the error text is preserved verbatim');
});

// ── B4: memory file ────────────────────────────────────────────────────────

test('B4: memory writes, reads, appends and stays bounded', () => {
    const savedFile = process.env.MEMORY_FILE;
    try {
        process.env.MEMORY_FILE = path.join(tmp, 'webchat_memory.md');
        memory.writeMemory('first fact');
        assert.strictEqual(memory.readMemory(), 'first fact');
        memory.appendMemory('second fact');
        assert.match(memory.readMemory(), /first fact/);
        assert.match(memory.readMemory(), /second fact/);

        const huge = 'z'.repeat(memory.MAX_MEMORY_CHARS + 500);
        memory.writeMemory(huge);
        assert.ok(memory.readMemory().length <= memory.MAX_MEMORY_CHARS, 'memory is capped');

        assert.match(memory.memoryBlock(), /### MEMORY/, 'the block is prompt-ready');
    } finally {
        if (savedFile === undefined) delete process.env.MEMORY_FILE; else process.env.MEMORY_FILE = savedFile;
    }
});

test('B4: read_memory/edit_memory tools work when memory is enabled', async () => {
    const saved = { enabled: config.memoryEnabled, file: process.env.MEMORY_FILE };
    try {
        config.memoryEnabled = true;
        process.env.MEMORY_FILE = path.join(tmp, 'tool_memory.md');
        await tools.executeTool('edit_memory', { content: 'persisted fact' });
        const r = await tools.executeTool('read_memory', {});
        assert.strictEqual(r.success, true);
        assert.match(r.content, /persisted fact/);
    } finally {
        config.memoryEnabled = saved.enabled;
        if (saved.file === undefined) delete process.env.MEMORY_FILE; else process.env.MEMORY_FILE = saved.file;
    }
});

// ── B2: MCP ────────────────────────────────────────────────────────────────

test('B2: normalizeSpec accepts command/args and url forms', () => {
    assert.deepStrictEqual(normalizeSpec({ command: 'node', args: ['x.js'] }), {
        kind: 'stdio', command: 'node', args: ['x.js'], env: normalizeSpec({ command: 'node' }).env, cwd: undefined,
    });
    const http = normalizeSpec({ url: 'http://127.0.0.1:9999/mcp' });
    assert.strictEqual(http.kind, 'http');
    assert.strictEqual(http.url, 'http://127.0.0.1:9999/mcp');
});

test('B2: normalizeMcpResult flattens content and surfaces errors', () => {
    assert.strictEqual(normalizeMcpResult({ content: [{ type: 'text', text: 'hello' }] }).content, 'hello');
    assert.strictEqual(normalizeMcpResult({ isError: true, content: [{ type: 'text', text: 'bad' }] }).success, false);
});

test('B2: a fake stdio MCP server is discovered and called', async () => {
    // A tiny JSON-RPC MCP server over newline-delimited stdio.
    const serverSrc = [
        "const rl = require('readline').createInterface({ input: process.stdin });",
        "rl.on('line', (line) => { let m; try { m = JSON.parse(line); } catch { return; }",
        "  const out = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');",
        "  if (m.method === 'initialize') out(m.id, { protocolVersion:'2024-11-05', capabilities:{}, serverInfo:{name:'fake',version:'1.0'} });",
        "  else if (m.method === 'tools/list') out(m.id, { tools: [{ name:'echo', description:'Echo', inputSchema:{ type:'object', properties:{ text:{type:'string'} } } }] });",
        "  else if (m.method === 'tools/call') out(m.id, { content: [{ type:'text', text:'echo:' + (m.params.arguments.text || '') }] });",
        "});",
    ].join('\n');
    const serverFile = path.join(tmp, 'fake_mcp_server.js');
    fs.writeFileSync(serverFile, serverSrc);

    const pool = new McpPool([{ name: 'fake', command: process.execPath, args: [serverFile] }]);
    await pool.discover();
    assert.strictEqual(pool.externalDefinitions().length, 1);
    assert.strictEqual(pool.externalDefinitions()[0].name, 'fake.echo');
    assert.ok(pool.has('fake.echo'));

    const r = await pool.execute('fake.echo', { text: 'hi' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.content, 'echo:hi');
    pool.closeAll();
});

test('B2: an unreachable MCP server is skipped, not fatal', async () => {
    const pool = new McpPool([{ name: 'dead', command: '/no/such/binary', args: [] }]);
    await pool.discover(); // must not throw
    assert.strictEqual(pool.externalDefinitions().length, 0, 'no tools from a dead server');
    assert.strictEqual(pool.has('dead.whatever'), false);
    pool.closeAll();
});
