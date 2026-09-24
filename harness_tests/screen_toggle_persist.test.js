'use strict';
//
// The checkbox screens (Agentic harness, Which webchats, Tools) rebuild their
// selection from disk at the TOP of every call, then redraw so the [x] is visible.
// Writing the choice only on 'Done' meant the redraw read the OLD file and dropped
// the toggle, so pressing Enter looked like it did nothing at all.
//
// This pins the persistence, not the cursor: after one Enter, the choice must be on
// disk, which is where the next call reads it from.
//
// Run: node --test harness_tests/screen_toggle_persist.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the CLI's state at a temp dir BEFORE anything reads it, so the test never
// touches the real launch.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-screen-'));
process.env.WEBCHAT_STATE_DIR = TMP;

const REPO = path.join(__dirname, '..');
const A = require(path.join(REPO, 'cli', 'ansi.js'));
const LC = require(path.join(REPO, 'cli', 'launchconfig.js'));
const H = require(path.join(REPO, 'cli', 'harnesses.js'));

test('Entering a harness writes it, so the redraw can see it', async () => {
    const buildScreens = require(path.join(REPO, 'cli', 'screens-gates.js')).build;
    const G = require(path.join(REPO, 'cli', 'gates.js'));
    const H2 = H;
    const screens = buildScreens({
        A, D: require(path.join(REPO, 'cli', 'daemon.js')), G, H: H2, LC,
        header: () => {}, shortHome: (s) => s, panel: (t, b) => [],
    });
    const target = H.HARNESSES[1].id;

    // One Enter on that row, then Esc out of the redrawn list.
    const answers = [target, A.BACK];
    const realMenu = A.menu;
    A.menu = async () => answers.shift();

    const realClear = A.clear, realHeader = A.header;
    A.clear = () => {}; A.line = () => {}; A.newline = () => {}; A.boxLines = (t, b) => [];
    A.dim = (s) => s; A.gray = (s) => s; A.bold = (s) => s;
    try {
        await screens.screenHarnesses();
    } finally {
        A.menu = realMenu; A.clear = realClear; A.header = realHeader;
    }

    const saved = LC.read().harnesses || [];
    assert.ok(saved.includes(target),
        `Enter must persist "${target}" immediately; launch.json holds ${JSON.stringify(saved)}`);
});

test('the saved choice survives a fresh read (what the redraw does)', async () => {
    const target = H.HARNESSES[2].id;
    LC.write({ harnesses: [target] });
    assert.deepStrictEqual(LC.read().harnesses, [target]);
});
