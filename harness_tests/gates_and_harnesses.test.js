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
    assert.strictEqual(H.modelIdFor({ id: 'gemini', site: 'gemini' }), 'gemini-webchat');
    assert.strictEqual(H.modelIdFor({ id: 'chatgpt' }), 'chatgpt-webchat',
        'the id is <site>-webchat, and it is also the model NAME the harness sends');
});

test('the environment points at the primary gate and names all of them', () => {
    const env = H.envFor([
        { id: 'gemini', gatewayPort: 8081 },
        { id: 'chatgpt', gatewayPort: 8082 },
    ]);
    assert.strictEqual(env.OPENAI_BASE_URL, 'http://127.0.0.1:8081/v1');
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8081');
    assert.strictEqual(env.HARNESS_MODEL_NAME, 'gemini-webchat', 'the name IS the id the gateway answers to');
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
    // The model KEY is the name the gateway answers to (`<site>-webchat`), because that is
    // what opencode resolves `webchat/<key>` against and what it then sends on the wire.
    // Keying by the bare gate id (`gemini`) produced a selector opencode could not match,
    // so it fell back to the user's global default (measured: providerID=openai
    // modelID=gpt-5.6-terra-pro) while our gateway sat unused.
    assert.deepStrictEqual(Object.keys(cfg.provider.webchat.models).sort(), ['chatgpt-webchat', 'gemini-webchat'],
        'every gate is named by the id the gateway answers to');
    assert.strictEqual(cfg.model, `webchat/${env.HARNESS_MODEL_NAME}`,
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
    // the config file - otherwise two of three modes launch an identical agent.
    //
    // The definition is about WHEN it asks, per the owner:
    //   manual = asks for EVERY tool call, so the wildcard is 'ask'
    //   auto   = proceeds by itself, asking only for RISKY commands. It must NOT ask
    //            on edit/write - that made it manual with extra steps and stopped the
    //            user on every file change, which is what the owner corrected.
    //   yolo   = never asks
    const manual = H.OPENCODE_PERMISSION.manual;
    const auto = H.OPENCODE_PERMISSION.auto;
    const yolo = H.OPENCODE_PERMISSION.yolo;
    assert.notDeepStrictEqual(manual, auto, 'manual and auto must not be the same');
    assert.notDeepStrictEqual(auto, yolo, 'auto and yolo must not be the same');
    assert.strictEqual(manual['*'], 'ask', 'manual asks for every tool call');
    assert.strictEqual(auto['*'], 'allow', 'auto lets ordinary calls through');
    assert.notStrictEqual(auto.edit, 'ask', 'editing a file is not the risky act');
    assert.strictEqual(auto.bash['*'], 'allow', 'an ordinary command is allowed');
    assert.strictEqual(auto.bash['rm -rf*'], 'ask', 'but a destructive one asks');
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

// ── the opencode model id must be PROVIDER-QUALIFIED ─────────────────────────
//
// This is the regression that made every launch silently run the user's own global
// default. opencode resolves `-m <provider>/<key>`; given a bare `deepseek-webchat` it
// matches no registered model and falls back to whatever the user's config says —
// measured live: providerID=openai modelID=gpt-5.6-terra-pro, then
// "AI_APICallError: Not Found" on every send, while our gateway sat unused.
//
// The gateway and opencode use two DIFFERENT namespaces and this pins both:
//   gateway answers to   deepseek-webchat          (HARNESS_MODEL_NAME, the request body)
//   opencode selects     webchat/deepseek-webchat  (-m, and the config `model`)
test('opencodeModelId prefixes the provider, and never double-prefixes', () => {
    assert.strictEqual(H.opencodeModelId('deepseek-webchat'), 'webchat/deepseek-webchat');
    assert.strictEqual(H.opencodeModelId('gemini-webchat'), 'webchat/gemini-webchat');
    assert.strictEqual(H.opencodeModelId('webchat/deepseek-webchat'), 'webchat/deepseek-webchat',
        'an already-qualified id must be left alone');
    assert.strictEqual(H.opencodeModelId(undefined), undefined,
        'a missing name stays missing so the NO_MODEL guard can fire');
});

test('the -m flag carries the provider-qualified id, not the bare gateway name', () => {
    const h = H.harnessById('opencode');
    const env = { HARNESS_MODEL_NAME: 'deepseek-webchat' };
    const argv = H.argvFor(h, 'auto', [], env);
    const i = argv.indexOf('-m');
    assert.ok(i >= 0, 'the model is pinned on the command line');
    assert.strictEqual(argv[i + 1], 'webchat/deepseek-webchat',
        'a bare deepseek-webchat resolves to nothing and opencode silently uses the global default');
});

test('the config model names a key that exists under its own provider', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'resolve-'));
    const gates = [{ id: 'deepseek', label: 'DeepSeek', site: 'deepseek' }];
    const env = H.envFor(gates, {});
    const written = H.prepareConfigFiles(H.harnessById('opencode'), gates, dir, env, 'auto');
    const cfg = JSON.parse(fs.readFileSync(written, 'utf-8'));

    // The whole failure was these two disagreeing: a model field that names no model.
    const keys = Object.keys(cfg.provider.webchat.models);
    const bare = String(cfg.model).replace(/^webchat\//, '');
    assert.ok(keys.includes(bare),
        `model "${cfg.model}" must resolve against provider "webchat" keys ${JSON.stringify(keys)}`);
    assert.strictEqual(cfg.model, `webchat/${env.HARNESS_MODEL_NAME}`,
        'and it must be the same id the -m flag uses, so flag and fallback cannot disagree');
});

// ── the Anthropic route needs a model the gateway knows ──────────────────────
//
// envFor set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN but NOT ANTHROPIC_MODEL, so the
// claude harness sent its own default name. /v1/messages does not recognise
// `claude-sonnet-4-20250514`: it misses WEBCHAT_ROUTES and proxies to the PAID upstream.
// Measured on the live gateway: 'deepseek-webchat' -> 200 (our tab),
// 'claude-sonnet-4-20250514' -> 401 "auth header format should be Bearer sk-..." (paid).
// Base URL and token alone are not a configuration; the model has to be named too.
test('envFor names the Anthropic model, so claude cannot fall through to the paid proxy', () => {
    const gates = [{ id: 'deepseek', site: 'deepseek', label: 'DeepSeek', gatewayPort: 8081, cdpPort: 9225 }];
    const env = H.envFor(gates, {});
    assert.strictEqual(env.ANTHROPIC_MODEL, 'deepseek-webchat',
        'without this claude sends its own model name and /v1/messages proxies to the paid API');
    assert.strictEqual(env.ANTHROPIC_MODEL, env.HARNESS_MODEL_NAME,
        'the anthropic and openai routes must name the same model, or the two harnesses disagree');
});
