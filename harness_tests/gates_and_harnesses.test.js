'use strict';
//
// The multi-webchat model, and the harnesses that can be launched against it.
//
// These are the parts the owner asked for by name: several webchats, several
// agentic harnesses, permission modes, a primed launch config — and an MCP server so
// any agent can drive all of it.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The registry is file-backed under the state dir, so point it somewhere disposable
// BEFORE requiring anything that resolves paths at call time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-gates-'));
process.env.WEBCHAT_STATE_DIR = TMP;
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
if (!fs.existsSync(process.env.HARNESS_CONFIG)) fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');

const G = require('../cli/gates.js');
const H = require('../cli/harnesses.js');
const LC = require('../cli/launchconfig.js');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── gates ────────────────────────────────────────────────────────────────────
test('several webchats can exist at once, each with its own profile and ports', () => {
    const a = G.add({ site: 'gemini', cdpPort: 9225, gatewayPort: 8081 });
    const b = G.add({ site: 'chatgpt', cdpPort: 9226, gatewayPort: 8082 });
    const all = G.read().gates;
    assert.strictEqual(all.length, 2);
    assert.notStrictEqual(a.profile, b.profile, 'two gates sharing one Chrome profile is the single-instance fight');
    assert.strictEqual(a.cdpPort, 9225);
    assert.strictEqual(b.gatewayPort, 8082);
});

test('two webchats of the same site get distinct ids', () => {
    const before = G.read().gates.length;
    const c = G.add({ site: 'gemini' });
    assert.ok(G.read().gates.length === before + 1);
    assert.notStrictEqual(c.id, 'gemini', 'the second gemini must not collide with the first');
});

test('a new webchat is NOT connected until the user says so', () => {
    // The harness cannot detect a login — a signed-out Gemini still renders an input
    // box — so this flag is the user's statement and must default to false.
    const g = G.add({ site: 'kimi' });
    assert.strictEqual(g.connected, false);
});

test('a URL identifies the site, and an unknown one falls back to generic', () => {
    assert.strictEqual(G.siteForUrl('https://chat.deepseek.com/a/chat'), 'deepseek');
    assert.strictEqual(G.siteForUrl('https://gemini.google.com/app'), 'gemini');
    assert.strictEqual(G.siteForUrl('https://example.com/whatever'), 'generic');
});

test('generic is a real site with no URL — the empty-browser path', () => {
    const generic = G.siteById('generic');
    assert.ok(generic, 'generic must exist: it is how an unlisted webchat is supported');
    assert.strictEqual(generic.url, '');
    assert.strictEqual(generic.generic, true);
});

test('removing a webchat also clears it as active', () => {
    const g = G.add({ site: 'notegpt' });
    G.setActive(g.id);
    assert.strictEqual(G.read().active, g.id);
    G.remove(g.id);
    assert.notStrictEqual(G.read().active, g.id, 'an active pointer to a removed gate is a dangling reference');
});

test('a corrupt registry does not take the CLI down', () => {
    fs.writeFileSync(G.registryFile(), '{ this is not json');
    const st = G.read();
    assert.deepStrictEqual(st.gates, []);
    assert.ok(st.error, 'it should say the file was unreadable rather than pretend it is empty');
});

// ── harnesses ────────────────────────────────────────────────────────────────
test('the five harnesses the owner named are all present', () => {
    const ids = H.HARNESSES.map((h) => h.id);
    for (const want of ['opencode', 'claude', 'codex', 'hermes', 'claw']) {
        assert.ok(ids.includes(want), `missing harness: ${want}`);
    }
});

test('claw code maps its permission modes onto its own flags', () => {
    const claw = H.harnessById('claw');
    assert.deepStrictEqual(H.argvFor(claw, 'manual'), []);
    assert.deepStrictEqual(H.argvFor(claw, 'auto'), ['--allow-write', '--allow-shell']);
    assert.deepStrictEqual(H.argvFor(claw, 'yolo'), ['--allow-write', '--allow-shell', '--unsafe']);
});

test('claude gets the flags it actually understands', () => {
    const claude = H.harnessById('claude');
    assert.deepStrictEqual(H.argvFor(claude, 'auto'), ['--permission-mode', 'acceptEdits']);
    assert.deepStrictEqual(H.argvFor(claude, 'yolo'), ['--dangerously-skip-permissions']);
});

test('manual mode never passes a write-enabling flag', () => {
    for (const h of H.HARNESSES) {
        const argv = H.argvFor(h, 'manual');
        const joined = argv.join(' ');
        assert.ok(!/allow-write|acceptEdits|skip-permissions|bypass/.test(joined),
            `${h.id} manual mode passed a permissive flag: ${joined}`);
    }
});

test('the model id carries the webchat id, so several model names exist', () => {
    // This is what makes multi-webchat useful inside an agent: it switches model and
    // gets a different account underneath.
    assert.strictEqual(H.modelIdFor({ id: 'gemini' }), 'webchat/gemini');
    assert.strictEqual(H.modelIdFor({ id: 'chatgpt' }), 'webchat/chatgpt');
});

test('the environment points at the primary gate and names all of them', () => {
    const env = H.envFor([
        { id: 'gemini', gatewayPort: 8081 },
        { id: 'chatgpt', gatewayPort: 8082 },
    ]);
    assert.strictEqual(env.OPENAI_BASE_URL, 'http://127.0.0.1:8081/v1');
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8081');
    assert.strictEqual(env.HARNESS_MODEL_NAME, 'webchat/gemini');
    assert.strictEqual(env.HARNESS_GATES, 'gemini,chatgpt');
});

test('reachability admits that a single-base-URL harness reaches one gate directly', () => {
    const r = H.reachability(H.harnessById('opencode'), [{ id: 'a' }, { id: 'b' }]);
    assert.strictEqual(r.direct, 1);
    assert.match(r.reason, /single base URL/);
});

test('opencode gets a config file written, and it names every gate', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'proj-'));
    const env = H.envFor([{ id: 'gemini', gatewayPort: 8081 }, { id: 'chatgpt', gatewayPort: 8081 }]);
    const wrote = H.prepareConfigFiles(H.harnessById('opencode'), [{ id: 'gemini', label: 'G', site: 'gemini' }, { id: 'chatgpt', label: 'C', site: 'chatgpt' }], dir, env);
    assert.ok(wrote && fs.existsSync(wrote));
    const cfg = JSON.parse(fs.readFileSync(wrote, 'utf-8'));
    // BARE keys under the provider. The provider is already called `webchat`, so writing
    // `webchat/gemini` here produced the id webchat/webchat/gemini - which neither the
    // config `model` nor `-m webchat/gemini` could match, so opencode fell back to the
    // user's global default (a paid API) while our gateway sat unused. Live-verified.
    assert.deepStrictEqual(Object.keys(cfg.provider.webchat.models).sort(), ['chatgpt', 'gemini'],
        'every gate is named, bare, under the webchat provider');
    assert.strictEqual(cfg.model, env.HARNESS_MODEL_NAME,
        'and the default model resolves as provider webchat + one of those keys');
    assert.deepStrictEqual(cfg.plugin, [], 'the gateway\'s plugins must not leak into the agent');
});

test('a harness that needs no config file gets none written', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'proj2-'));
    assert.strictEqual(H.prepareConfigFiles(H.harnessById('claude'), [], dir, {}), null);
    assert.ok(!fs.existsSync(path.join(dir, 'opencode.json')));
});

// ── the primed launch config ─────────────────────────────────────────────────
test('the launch config survives a round trip', () => {
    LC.write({ gates: ['gemini'], harnesses: ['opencode'], mode: 'yolo' });
    const back = LC.read();
    assert.deepStrictEqual(back.gates, ['gemini']);
    assert.deepStrictEqual(back.harnesses, ['opencode']);
    assert.strictEqual(back.mode, 'yolo');
});

test('an unready config is reported with the reasons, not launched', () => {
    // Each reason is checked on the input that actually produces it. An empty gate
    // list and a gate list naming something that no longer exists are DIFFERENT
    // problems and the user needs to be told which one they have.
    const empty = LC.validate({ gates: [], harnesses: [], mode: 'nonsense' }, []);
    assert.strictEqual(empty.ok, false);
    assert.ok(empty.problems.some((p) => /no webchat gate/.test(p)), 'nothing selected');
    assert.ok(empty.problems.some((p) => /no agentic harness/.test(p)), 'no harness');
    assert.ok(empty.problems.some((p) => /unknown permission mode/.test(p)), 'bad mode');

    const stale = LC.validate({ gates: ['ghost'], harnesses: ['opencode'], mode: 'auto' }, []);
    assert.strictEqual(stale.ok, false);
    assert.ok(stale.problems.some((p) => /no longer exists/.test(p)), 'a gate that was deleted');
});

test('a ready config has no problems', () => {
    const v = LC.validate({ gates: ['gemini'], harnesses: ['opencode'], mode: 'auto' }, [{ id: 'gemini' }]);
    assert.deepStrictEqual(v.problems, []);
    assert.strictEqual(v.ok, true);
});

// ── the MCP server ───────────────────────────────────────────────────────────
test('the MCP server exposes its tools without a live gateway', () => {
    const mcp = require('../src/tools/mcp-server.js');
    assert.ok(mcp.TOOLS.length >= 15, `expected a full surface, got ${mcp.TOOLS.length}`);
    for (const t of mcp.TOOLS) {
        assert.ok(t.name && t.description && t.inputSchema, `incomplete tool: ${t.name}`);
        assert.strictEqual(typeof t.handler, 'function');
    }
});

test('MCP tool names are unique and namespaced', () => {
    const mcp = require('../src/tools/mcp-server.js');
    const names = mcp.TOOLS.map((t) => t.name);
    assert.strictEqual(new Set(names).size, names.length, 'duplicate tool name');
    for (const n of names) assert.match(n, /^webchat_/, `unprefixed tool name: ${n}`);
});

test('the MCP server never writes a non-JSON line to stdout', () => {
    // Stdout IS the wire. A stray console.log corrupts the stream — measured: a config
    // warning printed straight into it and the client got a parse error.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'mcp-server.js'), 'utf-8');
    const guard = src.indexOf('STDOUT IS THE WIRE');
    const firstRequire = src.indexOf("const REPO =");
    assert.ok(guard > -1, 'the stdout guard must exist');
    assert.ok(guard < firstRequire && guard < src.indexOf('safeRequire'), 'the redirect must be installed before any module that might log is loaded');
});

test('adding a webchat makes it the active one', async () => {
    // Every tool that omits `gate` falls back to the active one. Told to add a SECOND
    // webchat and then launch, a caller that passes no gate must get the one it just
    // added — not gates[0], which measured as the FIRST webchat and the wrong browser.
    const before = G.read().gates.map((g) => g.id);
    const mcp = require('../src/tools/mcp-server.js');
    const tool = mcp.TOOLS.find((t) => t.name === 'webchat_gate_add');
    const res = await tool.handler({ site: 'deepseek' });
    const text = res.content ? res.content[0].text : String(res);
    const created = JSON.parse(text).created;
    assert.ok(!before.includes(created.id), 'should be a new gate');
    assert.strictEqual(G.read().active, created.id, 'the gate just created must become active');
});

// ── the flags must be REAL, and they must actually differ ────────────────────
test('opencode is never given --yolo, which it does not have', () => {
    // Verified with `opencode --help`: its options are --auto, --model, --pure, …
    // and there is no --yolo. A flag that does not exist fails the launch outright,
    // so the mode feature looked implemented and was broken for the default harness.
    const opencode = H.harnessById('opencode');
    for (const mode of ['manual', 'auto', 'yolo']) {
        assert.ok(!H.argvFor(opencode, mode).includes('--yolo'),
            `opencode ${mode} passed --yolo, which opencode does not accept`);
    }
    assert.ok(H.argvFor(opencode, 'auto').includes('--auto'), 'opencode auto-approves with --auto');
});

test('the permission modes are observably different for opencode', () => {
    // opencode has ONE permission flag, so the manual/auto distinction has to be in
    // the config file — otherwise two of three modes launch an identical agent.
    //
    // The definition is about WHEN it asks, per the owner:
    //   manual = asks for EVERY tool call, so the wildcard is 'ask'
    //   auto   = asks only for RISKY calls, so reads pass ('*': allow) while
    //            edit/write/bash/webfetch still ask
    //   yolo   = never asks, so everything is allow
    const manual = H.OPENCODE_PERMISSION.manual;
    const auto = H.OPENCODE_PERMISSION.auto;
    const yolo = H.OPENCODE_PERMISSION.yolo;
    assert.notDeepStrictEqual(manual, auto, 'manual and auto must not be the same');
    assert.strictEqual(manual['*'], 'ask', 'manual asks for every tool call');
    assert.strictEqual(auto['*'], 'allow', 'auto lets ordinary (read) calls through');
    assert.strictEqual(auto.edit, 'ask', 'auto still asks before a risky write');
    assert.strictEqual(yolo['*'], 'allow', 'yolo never asks');
});

test('the generated opencode config carries the chosen mode', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'perm-'));
    const env = { OPENAI_BASE_URL: 'http://127.0.0.1:8081/v1', HARNESS_MODEL_NAME: 'webchat/gemini' };
    const gates = [{ id: 'gemini', label: 'Gemini', site: 'gemini' }];
    const f = H.prepareConfigFiles(H.harnessById('opencode'), gates, dir, env, 'yolo');
    const cfg = JSON.parse(fs.readFileSync(f, 'utf-8'));
    assert.deepStrictEqual(cfg.permission, H.OPENCODE_PERMISSION.yolo);

    const dir2 = fs.mkdtempSync(path.join(TMP, 'perm2-'));
    const f2 = H.prepareConfigFiles(H.harnessById('opencode'), gates, dir2, env, 'manual');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, 'utf-8')).permission, H.OPENCODE_PERMISSION.manual);
});

test('a permission mode maps to flags the tool documents', () => {
    // Each of these was read out of the tool's own --help, not guessed.
    const claude = H.harnessById('claude');
    assert.ok(H.argvFor(claude, 'auto').includes('acceptEdits'), 'claude --permission-mode choices include acceptEdits');
    const codex = H.harnessById('codex');
    assert.deepStrictEqual(H.argvFor(codex, 'auto').slice(0, 2), ['--sandbox', 'workspace-write'],
        'codex -s choices are read-only | workspace-write | danger-full-access');
});

test('the generated config is marked as ours, and a stranger\'s is never overwritten', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'guard-'));
    const env = { OPENAI_BASE_URL: 'http://127.0.0.1:8081/v1', HARNESS_MODEL_NAME: 'webchat/gemini' };
    const gates = [{ id: 'gemini', label: 'Gemini', site: 'gemini' }];

    // First run writes, and marks the file.
    const f = H.prepareConfigFiles(H.harnessById('opencode'), gates, dir, env, 'manual');
    assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf-8'))._webchatHarness, true);

    // Second run over its OWN file is fine — that is the normal repeat.
    assert.doesNotThrow(() => H.prepareConfigFiles(H.harnessById('opencode'), gates, dir, env, 'auto'));

    // A hand-written opencode.json in the launch directory must NOT be flattened.
    // opencode merges a directory config with the user's global one, so clobbering it
    // would silently change how their own agent behaves.
    const other = fs.mkdtempSync(path.join(TMP, 'stranger-'));
    const precious = path.join(other, 'opencode.json');
    fs.writeFileSync(precious, JSON.stringify({ model: 'deepseek/deepseek-flash', plugin: ['x.js'] }, null, 2));
    assert.throws(
        () => H.prepareConfigFiles(H.harnessById('opencode'), gates, other, env, 'manual'),
        (e) => e.code === 'REFUSE_OVERWRITE',
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(precious, 'utf-8')).model, 'deepseek/deepseek-flash',
        'the existing file must be untouched');
});
