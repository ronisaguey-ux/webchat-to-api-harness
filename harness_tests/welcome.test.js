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

    // And the face is actually a face: two eyes and a mouth on the same figure.
    for (const f of [SK.IDLE, ...SK.WAVE]) {
        const joined = f.join('\n');
        assert.match(joined, /\^\s+\^/, `no eyes in frame ${JSON.stringify(f)}`);
        assert.match(joined, /_|___|---|\\___\//, `no mouth in frame ${JSON.stringify(f)}`);
    }
});

test('the wave actually moves', () => {
    const seen = SK.WAVE.map((f) => f.join('|'));
    assert.ok(new Set(seen).size > 1, 'every wave frame is identical, so nothing animates');
});

test('the greeting explains what the harness is, not just that it exists', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    // The greeting is delivered through the menu's `above` hook, because menu() clears
    // the screen on every redraw and would wipe anything drawn before it.
    let text = '';
    const realMenu = A.menu;
    A.menu = async (items, opts) => {
        text = (typeof opts.above === 'function' ? opts.above() : opts.above || []).join('\n');
        return 'skip';
    };
    try { await idx.screenWelcome(); } finally { A.menu = realMenu; }
    assert.match(text, /hello/i, 'it must greet');
    assert.match(text, /harness/i, 'it must name the thing');
    assert.match(text, /webchat/i, 'it must name what it drives');
    assert.match(text, /API/i, 'it must say what the webchat becomes');
    assert.match(text, /sign in/i, 'it must say the sign-in is the user\'s job');
    assert.match(text, /agent/i, 'it must say who benefits');
    // Roughly fifty words: enough to explain, short enough to be read rather than skipped.
    const words = text.replace(/[^A-Za-z0-9' -]/g, ' ').split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 35 && words <= 90, `the greeting is ${words} words - aim for about 50`);
});

test('the greeting is the FIRST thing, and the tour question comes after the platform', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const order = [];
    const real = { menu: A.menu, line: A.line, clear: A.clear, newline: A.newline, boxLines: A.boxLines };
    A.line = () => {}; A.clear = () => {}; A.newline = () => {}; A.boxLines = () => [];
    A.menu = async (items, opts) => {
        const title = (opts && opts.title) || (items[0] && items[0].label) || '';
        order.push(title);
        return items[0] && items[0].value;
    };
    try {
        await idx.screenWelcome();
        await idx.screenFirstRun();
        await idx.screenTourChoice();
    } finally { Object.assign(A, real); }

    assert.match(order[0], /welcome/i, `greeting must come first, got ${JSON.stringify(order)}`);
    assert.match(order[1], /agent running on/i, `platform must come second, got ${JSON.stringify(order)}`);
    assert.match(order[2], /tour/i, `the tour question must come last, got ${JSON.stringify(order)}`);
});

test('the wave never stops, however long the user leaves it', async () => {
    // He used to wave for twenty-four ticks and then settle into a still frame - which is
    // exactly what "the stickman is not even waving" was: by the time the paragraph had
    // been read, he had already stopped.
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    let opts = null;
    const c = capture([]);
    A.menu = async (items, o) => { opts = o; return 'ok'; };
    try { await idx.screenWelcome(); } finally { c.restore(); }

    assert.ok(opts && typeof opts.above === 'function', 'the greeting must draw above the menu');
    assert.ok(typeof opts.onTick === 'function' && opts.tickMs > 0,
        'a still picture is not a wave: it needs a tick and a redraw');

    // Sample the arm over far more ticks than a person would sit there.
    const armOf = () => opts.above().join('\n');
    const seen = new Set([armOf()]);
    for (let i = 0; i < 60; i++) { opts.onTick(); seen.add(armOf()); }
    assert.ok(seen.size > 1, 'the figure is identical on every redraw, so nothing moves');
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
    // Basic is deliberately short - the least it takes to get working. The bar is that it
    // covers the path, not that it is long.
    assert.ok(shown >= 4, `a tour of ${shown} card(s) does not cover the path`);
});

test('exiting the tour returns instead of running on', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const c = capture(['exit']);
    let done;
    try { done = await idx.screenTutorial(); } finally { c.restore(); }
    assert.strictEqual(done, false, 'exiting must report that the tour did not finish');
});

// ── tour mode: mocked writes, and a way out that always restores ─────────────

test('demo mode accepts a write and persists nothing', () => {
    const key = 'features.bashAllowed';
    const before = S.getPath(S.loadRaw().raw, key);
    const was = S.setDemoMode(true);
    const res = S.saveSetting(key, !before);
    const during = S.getPath(S.loadRaw().raw, key);
    S.setDemoMode(was);

    assert.strictEqual(res.ok, true, 'the screen must see success, or it will misbehave');
    assert.strictEqual(res.demo, true, 'and it must be told it is a mock');
    assert.strictEqual(during, before, 'nothing may be written while the tour runs');
});

test('every card offers an Exit, and it is named on screen', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const seen = [];
    const c = capture([]);
    A.menu = async (items, opts) => {
        seen.push({ titles: items.map((i) => i.label), footer: (opts.footer || []).join(' ') });
        return 'next';
    };
    try { await idx.screenTutorial('basic'); } finally { c.restore(); }

    assert.ok(seen.length > 1, 'the tour must have cards');
    for (const s of seen) {
        assert.ok(s.titles.includes('Exit the tour'), `a card has no exit: ${JSON.stringify(s.titles)}`);
        assert.match(s.footer, /Esc/, 'the footer must say how to leave without hunting for the button');
        assert.match(s.footer, /nothing is saved/i, 'the footer must say the tour is mocked');
    }
});

test('leaving mid-tour restores real writes', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const real = { menu: A.menu, line: A.line, clear: A.clear, newline: A.newline, boxLines: A.boxLines };
    A.line = () => {}; A.clear = () => {}; A.newline = () => {}; A.boxLines = () => [];
    A.menu = async () => A.BACK;                       // Esc, on the very first card
    try { await idx.screenTutorial('full'); } finally { Object.assign(A, real); }

    assert.strictEqual(S.isDemoMode(), false,
        'a demo flag left on would make the CLI silently stop saving');

    const key = 'features.bashAllowed';
    const before = S.getPath(S.loadRaw().raw, key);
    S.saveSetting(key, !before);
    assert.notStrictEqual(S.getPath(S.loadRaw().raw, key), before, 'writes must work again after the tour');
    S.saveSetting(key, before);
});

test('the full tour is longer than the basic one', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    const count = async (mode) => {
        let n = 0;
        const c = capture([]);
        A.menu = async () => { n++; return 'next'; };
        try { await idx.screenTutorial(mode); } finally { c.restore(); }
        return n;
    };
    const basic = await count('basic');
    const full = await count('full');
    assert.ok(full > basic, `full (${full}) must go deeper than basic (${basic})`);
});

test('the tour question offers exactly the three routes, in order', async () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    quiet();
    let offered = null;
    const c = capture([]);
    A.menu = async (items) => { offered = items; return 'skip'; };
    try { await idx.screenTourChoice(); } finally { c.restore(); }

    const values = (offered || []).map((i) => i.value);
    assert.deepStrictEqual(values, ['skip', 'basic', 'full'],
        `offered ${JSON.stringify(values)}`);
    const labels = (offered || []).map((i) => i.label);
    assert.ok(labels.some((l) => /straight/i.test(l)), 'the no-tour route must be named plainly');
});
