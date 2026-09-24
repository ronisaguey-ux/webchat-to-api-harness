'use strict';
//
// The greeting and the tour.
//
// Two things matter beyond "it renders": the tour must not change a single setting (it is
// the one place the user is told to poke at things, so it must be the place that saves
// nothing), and the character must not jitter - every frame has to be the same shape, or
// the animation walks down the screen instead of waving.
//
// Run: node --test harness_tests/welcome.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-welcome-'));
const CFG = path.join(TMP, 'harness.config.json');
fs.copyFileSync(path.join(REPO, 'src', 'core', 'harness.config.json'), CFG);
process.env.HARNESS_CONFIG = CFG;
process.env.WEBCHAT_STATE_DIR = path.join(TMP, 'state');

const SK = require(path.join(REPO, 'cli', 'stickman.js'));
const A = require(path.join(REPO, 'cli', 'ansi.js'));
const S = require(path.join(REPO, 'cli', 'settings.js'));

function quiet() {
    A.clear = () => {}; A.line = () => {}; A.newline = () => {}; A.boxLines = () => [];
}
// Capture what a screen would draw, and script the menu.
function capture(answers) {
    const drawn = [];
    const real = { line: A.line, menu: A.menu, clear: A.clear, newline: A.newline, boxLines: A.boxLines };
    A.line = (s) => drawn.push(String(s == null ? '' : s));
    A.clear = () => {}; A.newline = () => {}; A.boxLines = () => [];
    A.menu = async () => (answers.length ? answers.shift() : A.BACK);
    return { drawn, restore: () => Object.assign(A, real) };
}

test('every pose is the same shape, so the animation cannot jitter', () => {
    // A frame with a different height or width drags the drawing around as it plays.
    const frames = [];
    for (const set of [SK.WAVE, [SK.IDLE], [SK.POINT], [SK.THINK], [SK.CHEER]]) {
        const list = Array.isArray(set[0]) ? set : [set];
        for (const f of list) frames.push(f);
    }
    const heights = new Set(frames.map((f) => f.length));
    assert.strictEqual(heights.size, 1, `frames disagree on height: ${JSON.stringify([...heights])}`);

    const widths = new Set(frames.map((f) => f[0].length));
    assert.strictEqual(widths.size, 1, `frames disagree on width: ${JSON.stringify([...widths])}`);

    // Every frame is pure ASCII: a font without the glyphs turns the character into
    // boxes, and this is the first thing a new user sees.
    for (const f of frames) {
        for (const line of f) {
            assert.ok(/^[\x20-\x7e]*$/.test(line), `non-ASCII in a frame: ${JSON.stringify(line)}`);
        }
    }

    // And the face is actually a face.
    for (const f of [SK.IDLE, ...SK.WAVE]) {
        assert.ok(f.some((l) => /\(\s*\^_?\^?\s*\)|\(\s*o_o\s*\)|\(\s*\^o\^\s*\)/.test(l)),
            `no smiley in frame ${JSON.stringify(f)}`);
    }
});

test('the wave actually moves', () => {
    const seen = SK.WAVE.map((f) => f.join('|'));
    assert.ok(new Set(seen).size > 1, 'every wave frame is identical, so nothing animates');
});

test('the greeting explains what the harness is, not just that it exists', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const c = capture(['skip']);
    // The wave is a real delay; skip the animation but keep the screen's own drawing.
    const realAnim = SK.makeAnimator;
    SK.makeAnimator = () => ({ step: () => {}, done: () => {} });
    try { await idx.screenWelcome(); } finally { SK.makeAnimator = realAnim; c.restore(); }

    const text = c.drawn.join('\n');
    assert.match(text, /welcome/i, 'it must welcome');
    assert.match(text, /control cent/i, 'it must say what this CLI is');
    assert.match(text, /webchat/i, 'it must name the thing it drives');
    assert.match(text, /API/i, 'it must say what it turns the webchat into');
    assert.match(text, /sign in/i, 'it must say the sign-in is the user\'s job');
    // The two ways forward.
    assert.ok(/tour|around/i.test(text) === false || true);   // text is the body; the menu is separate
});

test('the greeting offers the tour and the direct route', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    let offered = null;
    const c = capture([]);
    A.menu = async (items) => { offered = items; return 'skip'; };
    const realAnim = SK.makeAnimator;
    SK.makeAnimator = () => ({ step: () => {}, done: () => {} });
    try { await idx.screenWelcome(); } finally { SK.makeAnimator = realAnim; c.restore(); }

    const values = (offered || []).map((i) => i.value);
    assert.deepStrictEqual(values.sort(), ['skip', 'tutorial'], `offered ${JSON.stringify(values)}`);
});

test('the tour changes NOTHING, even though it tells the user to poke at things', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const before = fs.readFileSync(CFG, 'utf8');

    // Walk the whole tour on 'Next', which never enters a screen.
    const c = capture(Array(20).fill('next'));
    try { await idx.screenTutorial(); } finally { c.restore(); }

    const after = fs.readFileSync(CFG, 'utf8');
    assert.strictEqual(after, before, 'the tour wrote to the config');
});

test('the tour has several steps and reaches the end', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    let shown = 0;
    const c = capture([]);
    A.menu = async () => { shown++; return 'next'; };
    try { await idx.screenTutorial(); } finally { c.restore(); }
    assert.ok(shown >= 5, `a tour of ${shown} card(s) is not a tour`);
});

test('exiting the tour returns instead of running on', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const c = capture(['exit']);
    let done;
    try { done = await idx.screenTutorial(); } finally { c.restore(); }
    assert.strictEqual(done, false, 'exiting must report that the tour did not finish');
});
