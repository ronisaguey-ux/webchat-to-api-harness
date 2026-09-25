'use strict';
//
// The agent is launched into its OWN folder, holding only the config this CLI generates.
//
// It used to launch in the user's HOME. Two things went wrong with that, and both were
// seen live: the generated opencode.json landed in ~ where opencode merges it with the
// user's own global config, and the agent then ran on a paid provider while the webchat
// sat unused. The isolated folder is the fix and this pins it.
//
// Run: node --test harness_tests/launch_dir.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const LC = require(path.join(REPO, 'cli', 'launchconfig.js'));
const H = require(path.join(REPO, 'cli', 'harnesses.js'));

test('the default launch directory is NOT the user\'s home', () => {
    const home = process.env.HOME;
    assert.notStrictEqual(LC.DEFAULT.cwd, home,
        'launching in HOME writes opencode.json into the user\'s home directory');
    assert.ok(LC.DEFAULT.cwd.startsWith(home + path.sep),
        `it should still live under the home tree, got ${LC.DEFAULT.cwd}`);
    assert.strictEqual(LC.DEFAULT.cwd, LC.agentDir());
});

test('a saved config pointing at HOME is migrated on read', () => {
    const file = LC.file();
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    try {
        LC.ensureStateDirForTest ? LC.ensureStateDirForTest() : null;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ gates: ['deepseek'], harnesses: ['opencode'], cwd: process.env.HOME }, null, 2));
        const cfg = LC.read();
        assert.notStrictEqual(cfg.cwd, process.env.HOME, 'the old HOME default must not survive a read');
        assert.strictEqual(cfg.cwd, LC.agentDir());
    } finally {
        if (before === null) { try { fs.unlinkSync(file); } catch { /* fine */ } }
        else fs.writeFileSync(file, before);
    }
});

test('the generated agent config is written into the isolated folder, not HOME', () => {
    // A TEMP dir, never the live agent dir. This test used to call LC.ensureAgentDir() —
    // which resolves to the REAL ~/.webchat/agent — and write a config carrying a FAKE
    // gatewayPort (8181, not the gateway's 8081) straight into it. Running the suite
    // therefore broke the installed launch: the agent connected to a port nothing serves.
    // A test must not write into live state; it only needs to prove WHERE the file lands.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdir-'));
    const gates = [{ id: 'deepseek', site: 'deepseek', label: 'DeepSeek webchat', gatewayPort: 8181, cdpPort: 9281 }];
    const env = H.envFor(gates);

    const homeCfg = path.join(process.env.HOME, 'opencode.json');
    const hadHome = fs.existsSync(homeCfg);
    const written = H.prepareConfigFiles(H.harnessById('opencode'), gates, dir, env, 'auto');

    assert.strictEqual(written, path.join(dir, 'opencode.json'),
        'the config belongs in the agent folder');
    const cfg = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.strictEqual(cfg.model, `webchat/${env.HARNESS_MODEL_NAME}`, 'the agent must be pointed at the webchat model');
    assert.match(cfg.provider.webchat.options.baseURL, /:\d+\/v1$/,
        'the provider must point at the harness gateway');
    assert.strictEqual(fs.existsSync(homeCfg), hadHome,
        'writing the agent config must not create or touch ~/opencode.json');
});

test('connect fills in what the machine already knows, instead of asking the user', () => {
    // It used to print "Nothing is configured yet" and send the user to another terminal.
    // A connected gate and an installed harness are facts, not preferences, so they are
    // filled in. Pure function, so this needs no TTY and no launch.
    const gates = [
        { id: 'deepseek', connected: true },
        { id: 'gemini', connected: false },
    ];
    const r = LC.autofill({ gates: [], harnesses: [], mode: 'auto' }, gates, () => 'opencode');
    assert.deepStrictEqual(r.filled, { gates: ['deepseek'], harnesses: ['opencode'] });
    assert.deepStrictEqual(r.cfg.gates, ['deepseek'], 'the CONNECTED gate is chosen');
    assert.deepStrictEqual(r.cfg.harnesses, ['opencode']);

    // A choice the user already made is never overridden.
    const kept = LC.autofill({ gates: ['gemini'], harnesses: ['claude'] }, gates, () => 'opencode');
    assert.deepStrictEqual(kept.filled, {}, 'an explicit selection is left alone');
    assert.deepStrictEqual(kept.cfg.gates, ['gemini']);

    // Nothing usable to pick: no invention, and no crash.
    const none = LC.autofill({ gates: [], harnesses: [] }, [], () => null);
    assert.deepStrictEqual(none.filled, {});
});

test('auto proceeds by itself and stops only for the risky commands', () => {
    // `auto` asked on edit, write, bash AND webfetch, which is most of what an agent
    // does - so it behaved like manual with extra steps and stopped the user on every
    // file change. The majority is allowed; only genuinely destructive, irreversible or
    // secret-leaking commands interrupt.
    const P = H.OPENCODE_PERMISSION;
    assert.strictEqual(P.auto['*'], 'allow', 'ordinary tools run without asking');
    assert.notStrictEqual(P.auto.edit, 'ask', 'editing a file is not a risky act');
    assert.notStrictEqual(P.auto.write, 'ask', 'writing a file is not a risky act');
    assert.strictEqual(P.auto.bash['*'], 'allow', 'an ordinary command runs without asking');

    // Last matching rule wins, so every risky pattern must come after the catch-all.
    const keys = Object.keys(P.auto.bash);
    assert.strictEqual(keys[0], '*', 'the catch-all must be first or it would shadow the rules');
    for (const pat of ['rm -rf*', 'sudo *', 'git push --force*', 'git reset --hard*', '*ghp_*']) {
        assert.strictEqual(P.auto.bash[pat], 'ask', `${pat} must ask`);
    }

    // The three modes must stay three modes, not two spellings of the same thing.
    assert.strictEqual(P.manual['*'], 'ask', 'manual asks for everything');
    assert.deepStrictEqual(P.yolo, { '*': 'allow' }, 'yolo never asks');
    assert.notDeepStrictEqual(P.auto, P.yolo);
    assert.notDeepStrictEqual(P.auto, P.manual);
});

test('the agent gets its own window, and the CLI keeps this terminal', () => {
    // Launching used to spawnSync(..., stdio: 'inherit'), which REPLACES the terminal the
    // user is standing in - so the CLI they were just using disappears. The agent is
    // launched into its own window (or detached, with a log) instead.
    const src = fs.readFileSync(path.join(REPO, 'cli', 'index.js'), 'utf8');
    assert.ok(!/spawnSync\(first\.h\.bin/.test(src),
        'the agent must not be spawned onto this terminal');
    assert.match(src, /D\.launchInTerminal\(/, 'it goes through the launcher instead');
    assert.match(src, /this terminal stays yours/, 'and it says so');

    const D = require(path.join(REPO, 'cli', 'daemon.js'));
    assert.strictEqual(typeof D.launchInTerminal, 'function');
    // Either a terminal emulator was found, or the detached fallback is used - never a
    // crash, and never a silent no-op.
    const t = D.whichTerminal();
    assert.ok(t === null || (t && typeof t.bin === 'string'));
});

test('start is the command and connect still works as an alias', () => {
    const src = fs.readFileSync(path.join(REPO, 'cli', 'index.js'), 'utf8');
    assert.match(src, /cmd === 'start' \|\| cmd === 'connect'/, 'both names dispatch');
    assert.match(src, /async function cmdStart\(/, 'the implementation is named start');
    assert.ok(!/cmdConnect\b/.test(src), 'the old name is gone, not left dangling');
});

test('the Webchats list offers only live webchats, plus Add', async () => {
    // It used to list a "Connect <site>" row per CONFIGURED gate, so a signed-out DeepSeek
    // sat there as a to-do item for a webchat the user had not added - and the list read
    // as a list of things that do not work. Only a live webchat is listed; otherwise the
    // one action is adding one.
    const A = require(path.join(REPO, 'cli', 'ansi.js'));
    const G = require(path.join(REPO, 'cli', 'gates.js'));
    const SG = require(path.join(REPO, 'cli', 'screens-gates.js'));

    const real = { menu: A.menu, line: A.line, clear: A.clear, newline: A.newline, boxLines: A.boxLines, header: A.header, gray: A.gray };
    let seen = null;
    A.line = () => {}; A.clear = () => {}; A.newline = () => {};
    A.boxLines = () => ['box']; A.header = () => {};
    A.menu = async (items) => { seen = items; return A.BACK; };
    const realRefresh = G.refresh;
    G.refresh = async () => ({ gates: [{ id: 'deepseek', site: 'deepseek', label: 'DeepSeek webchat', connected: false }], active: null });
    try {
        // build() threads its helpers in explicitly (it has no require fallback for G),
        // so a test has to hand it the real ones.
        const ctx = {
            A,
            G,
            D: require(path.join(REPO, 'cli', 'daemon.js')),
            H: require(path.join(REPO, 'cli', 'harnesses.js')),
            LC: require(path.join(REPO, 'cli', 'launchconfig.js')),
            header: () => {},
            shortHome: (s) => String(s),
            panel: async () => {},
        };
        await SG.build(ctx).screenGates();
    } finally {
        Object.assign(A, real); G.refresh = realRefresh;
    }

    assert.ok(seen, 'the screen must render a menu');
    const labels = seen.map((i) => i.label);
    assert.ok(!labels.some((l) => /^Connect /.test(l)),
        `no "Connect <site>" rows - got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('Add a webchat'), 'adding one is the action');
    assert.ok(!labels.some((l) => /Gemini|DeepSeek/.test(l)),
        'a webchat that is not live must not be listed at all');
});

test('the agent is launched into its OWN opencode, not the user\'s', async () => {
    // opencode merges the config in the working directory with the user's GLOBAL one. A
    // clean folder was therefore not enough: the global config still supplied a paid
    // provider, the user's own default model, their agents, their system prompts and their
    // memory - which is exactly what launched. The harness points opencode at its own
    // config and data dirs so the user's setup is never loaded and its keys never reachable.
    const H = require(path.join(REPO, 'cli', 'harnesses.js'));
    const cwd = '/tmp/agent-env-test';

    const env = H.isolateHarnessEnv(cwd);
    assert.equal(env.XDG_CONFIG_HOME, path.join(cwd, '.config'));
    assert.equal(env.XDG_DATA_HOME, path.join(cwd, '.local', 'share'));
    // The config the agent reads has to EXIST at the isolated path, or opencode falls back
    // to its built-in defaults rather than ours.
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
        assert.ok(env[k] && env[k].startsWith(cwd), `${k} must be isolated under the agent dir`);
    }

    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd, { recursive: true });
    const gates = [{ id: 'deepseek', site: 'deepseek', label: 'DeepSeek webchat', gatewayPort: 8181, cdpPort: 9281 }];
    const model = H.modelIdFor(gates[0]);
    const envFor = H.envFor(gates);
    assert.equal(envFor.HARNESS_MODEL_NAME, model, 'the env carries the id the config uses');
    const written = H.prepareConfigFiles({ id: 'opencode', modelFlag: '-m' }, gates, cwd, envFor, 'auto');
    assert.ok(written, 'a config is written');
    assert.ok(fs.existsSync(path.join(cwd, '.config', 'opencode', 'opencode.json')),
        'and at the path the isolated XDG_CONFIG_HOME resolves to');
    const cfg = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.equal(cfg.model, `webchat/${model}`, 'the config points at provider webchat + our model key');
    assert.equal(Object.keys(cfg.provider.webchat.models).length, 1, 'only our provider');
    fs.rmSync(cwd, { recursive: true, force: true });
});

test('launching from the menu comes back to the menu instead of ending the CLI', () => {
    // `return cmdStart([])` in the menu branch exited the CLI, so launching an agent closed
    // the terminal the user was standing in. Launching is a detour, not an exit.
    const src = fs.readFileSync(path.join(REPO, 'cli', 'index.js'), 'utf8');
    // `return cmdStart(...)` is only right where it IS the command the user typed. Inside the
    // menu it ends the CLI, which is why launching an agent closed the terminal.
    const menuBranch = /if \(next === 'launch'\)([^\n]*)/.exec(src);
    assert.ok(menuBranch, 'the menu has a launch branch');
    assert.ok(!/return\s+cmdStart/.test(menuBranch[1]),
        'the menu launch branch may not return - that ends the CLI');
    assert.match(menuBranch[1], /await cmdStart\(\[\]\); continue;/,
        'it must continue the loop and come back to the menu');
});
