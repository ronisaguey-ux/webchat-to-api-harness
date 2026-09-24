'use strict';
//
// Bob opened Tools and the CLI died with:
//
//     Cannot read properties of undefined (reading 'value')
//
// screenTools read ONE array setting called `tools.disabled`. The schema has no such
// path -- each tool is its OWN setting, `tools.disabled::<name>`, default false. So the
// first row lookup returned undefined, `.value` threw, and the screen never drew.
//
// This pins the two things that were wrong: the screen must render, and Enter must write
// the setting that actually owns that tool.
//
// Run: node --test harness_tests/screen_tools.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

// A throwaway config, so a toggle in this test cannot touch the real harness.config.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-tools-'));
process.env.WEBCHAT_STATE_DIR = TMP;
const CFG = path.join(TMP, 'harness.config.json');
fs.copyFileSync(path.join(REPO, 'src', 'core', 'harness.config.json'), CFG);
process.env.HARNESS_CONFIG = CFG;

const A = require(path.join(REPO, 'cli', 'ansi.js'));
const S = require(path.join(REPO, 'cli', 'settings.js'));
const G = require(path.join(REPO, 'cli', 'gates.js'));
const LC = require(path.join(REPO, 'cli', 'launchconfig.js'));
const H = require(path.join(REPO, 'cli', 'harnesses.js'));
const D = require(path.join(REPO, 'cli', 'daemon.js'));

function screens() {
    return require(path.join(REPO, 'cli', 'screens-gates.js')).build({
        A, D, G, H, LC,
        header: () => {}, shortHome: (s) => s, panel: (t, b) => [],
        state: () => {
            const { raw, file, missing, error } = S.loadRaw();
            return { raw, file, missing, error, dotenv: {}, dotenvFile: S.envFilePath() };
        },
        rowsOf: (st) => S.resolveAll(st.raw, process.env, st.dotenv || {}),
        saveSetting: (p, v) => S.saveSetting(p, v),
    });
}

// Silence the drawing and feed the menu a scripted answer.
function withMenu(answers, fn) {
    const real = { menu: A.menu, clear: A.clear, line: A.line, newline: A.newline, boxLines: A.boxLines };
    A.menu = async () => answers.shift();
    A.clear = () => {}; A.line = () => {}; A.newline = () => {}; A.boxLines = () => [];
    return Promise.resolve().then(fn).finally(() => Object.assign(A, real));
}

test('the Tools screen renders instead of dying on a missing row', async () => {
    // The exact failure: reading `.value` off a row that does not exist. Esc straight out.
    await withMenu([A.BACK], async () => {
        await screens().screenTools();
    });
});

// The resolver reports `value = !off.includes(name)`: TRUE means the tool is AVAILABLE.
// So the stored list holds the DISABLED names and `value` is the opposite of membership.
// A screen that confuses the two draws every tick on the wrong row.
function available(name) {
    const row = S.resolveAll(S.loadRaw().raw, process.env, {})
        .find((r) => r.setting.path === `tools.disabled::${name}`);
    assert.ok(row, `tools.disabled::${name} must exist in the schema`);
    return row.value;
}

function disabledList() {
    const raw = S.loadRaw().raw;
    return Array.isArray(raw.tools && raw.tools.disabled) ? raw.tools.disabled : [];
}

test('the stored list and the resolved value agree on what is off', () => {
    S.saveSetting('tools.disabled::read_file', false);   // false = switch it off
    assert.strictEqual(available('read_file'), false, 'switched off must resolve to false');
    assert.ok(disabledList().includes('read_file'), 'and must appear in tools.disabled');

    S.saveSetting('tools.disabled::read_file', true);    // true = switch it on
    assert.strictEqual(available('read_file'), true, 'switched on must resolve to true');
    assert.ok(!disabledList().includes('read_file'), 'and must leave tools.disabled');
});

test('Enter flips the tool it was pressed on', async () => {
    // Start available, so a single Enter must switch it OFF.
    S.saveSetting('tools.disabled::read_file', true);
    assert.strictEqual(available('read_file'), true);

    await withMenu(['read_file', A.BACK], async () => { await screens().screenTools(); });

    assert.strictEqual(available('read_file'), false,
        'Enter on an available tool must switch it off');
    assert.ok(disabledList().includes('read_file'),
        `the config must record it; holds ${JSON.stringify(S.loadRaw().raw.tools)}`);
});

test('a second Enter switches it back on', async () => {
    // Seed explicitly: every test here shares one config file, so the state left by the
    // previous test is not a starting point.
    S.saveSetting('tools.disabled::read_file', true);
    assert.strictEqual(available('read_file'), true, 'seeded available');

    for (let i = 0; i < 2; i++) {
        await withMenu(['read_file', A.BACK], async () => { await screens().screenTools(); });
    }

    assert.strictEqual(available('read_file'), true, 'two Enters must leave it as it started');
    assert.ok(!disabledList().includes('read_file'), `holds ${JSON.stringify(disabledList())}`);
});
