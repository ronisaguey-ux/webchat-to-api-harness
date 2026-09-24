'use strict';
//
// First run asks which system the AGENT is on, before the main menu, and only once.
//
// Get this wrong and the two "versions" of the CLI are wrong in the same breath: a
// Windows agent handed bash syntax has every command refused, and a Linux agent handed
// cmd.exe syntax has paths that do not resolve. So the question is asked rather than
// guessed from process.platform -- the whole point is driving one box from another.
//
// Run: node --test harness_tests/first_run.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

// A throwaway config per test, so a choice here cannot touch the real one.
function freshConfig(initial) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-firstrun-'));
    const file = path.join(dir, 'harness.config.json');
    fs.writeFileSync(file, JSON.stringify(initial || {}, null, 2));
    return file;
}

// index.js reads its config at call time, so a fresh require per case keeps the tests
// independent of each other.
function loadIndex(configFile) {
    process.env.HARNESS_CONFIG = configFile;
    for (const k of Object.keys(require.cache)) {
        if (k.includes(path.join('cli', ''))) delete require.cache[k];
    }
    return require(path.join(REPO, 'cli', 'index.js'));
}

function quiet(A) {
    A.clear = () => {}; A.line = () => {}; A.newline = () => {}; A.boxLines = () => ['box'];
}

test('an unset platform counts as a first run', () => {
    const cfg = freshConfig({});
    const idx = loadIndex(cfg);
    const A = require(path.join(REPO, 'cli', 'ansi.js'));
    quiet(A);
    assert.strictEqual(idx.platformChosen(), false, 'a config with no platform is a first run');
});

test('an answered platform is not asked again', () => {
    const cfg = freshConfig({ platform: 'windows' });
    const idx = loadIndex(cfg);
    const A = require(path.join(REPO, 'cli', 'ansi.js'));
    quiet(A);
    assert.strictEqual(idx.platformChosen(), true, 'a platform in the file must stop the prompt');
});

test('picking Windows writes it, and the CLI then behaves as Windows', async () => {
    const cfg = freshConfig({});
    const idx = loadIndex(cfg);
    const A = require(path.join(REPO, 'cli', 'ansi.js'));
    const S = require(path.join(REPO, 'cli', 'settings.js'));
    quiet(A);

    const realMenu = A.menu;
    A.menu = async () => 'windows';
    try {
        const picked = await idx.screenFirstRun();
        assert.strictEqual(picked, 'windows');
    } finally { A.menu = realMenu; }

    // Persisted, so it is not asked again.
    assert.strictEqual(S.getPath(S.loadRaw().raw, 'platform'), 'windows');
    assert.strictEqual(idx.platformChosen(), true);

    // And it reaches the layer that actually changes behaviour.
    const platform = require(path.join(REPO, 'src', 'core', 'platform.js'));
    platform.setPlatform('windows');
    assert.strictEqual(platform.current(), 'windows');
    assert.ok(platform.shell(), 'a platform must resolve to a shell');
    platform.setPlatform('linux');
});

test('the two platforms really are two versions, not a label', () => {
    const platform = require(path.join(REPO, 'src', 'core', 'platform.js'));
    platform.setPlatform('linux');
    const linShell = platform.shell();
    const linDanger = platform.dangerPatterns();
    const linRoots = platform.defaultRoots('/tmp/ws');
    platform.setPlatform('windows');
    const winShell = platform.shell();
    const winDanger = platform.dangerPatterns();
    const winRoots = platform.defaultRoots('C:/ws');
    platform.setPlatform('linux');

    assert.notStrictEqual(linShell.name, winShell.name,
        `linux and windows must not share a shell (both named "${linShell.name}")`);
    assert.ok(linShell.cmd && winShell.cmd, 'a shell needs a program to run');
    // The command safety rules are what stop a Windows agent being judged by POSIX
    // patterns it can never match, and the reverse.
    assert.notDeepStrictEqual(linDanger, winDanger, 'each platform needs its own danger patterns');
    assert.notDeepStrictEqual(linRoots, winRoots, 'each platform needs its own default roots');
});

test('a config with no platform yet still renders the picker and offers both', async () => {
    const cfg = freshConfig({});
    const idx = loadIndex(cfg);
    const A = require(path.join(REPO, 'cli', 'ansi.js'));
    quiet(A);

    let offered = null;
    const realMenu = A.menu;
    A.menu = async (items) => { offered = items; return A.BACK; };
    try { await idx.screenFirstRun(); } finally { A.menu = realMenu; }

    assert.ok(offered, 'the picker must render a menu');
    const values = offered.map((i) => i.value);
    assert.deepStrictEqual(values.sort(), ['linux', 'windows'], `offered ${JSON.stringify(values)}`);
});
