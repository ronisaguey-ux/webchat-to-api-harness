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
    const dir = LC.ensureAgentDir();
    const gates = [{ id: 'deepseek', site: 'deepseek', label: 'DeepSeek webchat', gatewayPort: 8181, cdpPort: 9281 }];
    const env = H.envFor(gates);

    const homeCfg = path.join(process.env.HOME, 'opencode.json');
    const hadHome = fs.existsSync(homeCfg);
    const written = H.prepareConfigFiles(H.harnessById('opencode'), gates, dir, env, 'auto');

    assert.strictEqual(written, path.join(dir, 'opencode.json'),
        'the config belongs in the agent folder');
    const cfg = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.strictEqual(cfg.model, env.HARNESS_MODEL_NAME, 'the agent must be pointed at the webchat model');
    assert.match(cfg.provider.webchat.options.baseURL, /:\d+\/v1$/,
        'the provider must point at the harness gateway');
    assert.strictEqual(fs.existsSync(homeCfg), hadHome,
        'writing the agent config must not create or touch ~/opencode.json');
});
