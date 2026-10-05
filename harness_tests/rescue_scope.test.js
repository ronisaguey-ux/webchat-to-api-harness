'use strict';
//
// RESCUE-PATH SCOPING REGRESSION.
//
// waitForResponse(before, typedText) has two phases: the main poll loop, and — once the
// deadline passes — a bounded RESCUE loop that hands back an answer already sitting on the
// tab instead of failing the request. The rescue loop was dead code:
//
//   3359:  const busyNow = state.mode === 'vl' ? ...
//
// `state` is declared with `let` INSIDE the main loop's block (line 2945), so by the time
// the rescue loop runs it is out of scope. JS resolves the bare name as a GLOBAL lookup,
// which throws ReferenceError; the `catch { await sleep(1500) }` at 3381 swallows it. Every
// rescue iteration therefore died on that line, so the DOM rescue (return last.answer),
// the "still generating past the deadline" extension and the "stuck send" break could
// never run — the loop only ever spun to the hard cap and threw "Timed out". The answer
// on the tab was thrown away.
//
// This test extracts the REAL `waitForResponse` source text out of browser.js (brace-
// matched, no re-implementation) and executes it against stubs, so it exercises the shipped
// code path rather than a copy of it. A replica would have passed while the shipped
// function stayed broken — that is precisely the trap this bug lives in.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-rescue-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');

/** Brace-match a top-level `async function NAME(` out of browser.js, verbatim. */
function extractFn(name) {
    const src = fs.readFileSync(path.join(REPO, 'src', 'browser', 'browser.js'), 'utf-8');
    const head = `async function ${name}(`;
    const i = src.indexOf(head);
    assert.notStrictEqual(i, -1, `${name} must exist in src/browser/browser.js`);
    const open = src.indexOf('{', i);
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    assert.ok(j < src.length, `${name} must be brace-balanced`);
    return src.slice(i, j + 1);
}

// Every free identifier waitForResponse closes over. Supplying them as parameters is what
// lets the real function body run outside the module.
const STUBS = [
    'config', 'sleep', 'page', 'snapshotChat', 'readStreamedAnswer', 'isGenerating',
    'isForeignBusy', 'clickContinueIfPresent', 'isTabGenerating', 'selfHealDeadTab',
    'probeRendererAlive', 'dropDeadRenderer', 'markProgress', 'quirk',
    'looksLikeTruncatedAnswer', 'streamError', 'RENDERER_DEAD_AFTER', 'browserAlive',
    'browser',
];

function loadWaitForResponse(over = {}) {
    const refs = {
        // timeout in the past -> the main poll loop is skipped and we land in the rescue.
        config: { timeout: -1000, webchatUrl: 'https://example.test/c', emptyGraceMs: 0 },
        sleep: async () => {},
        page: { isClosed: () => false, evaluate: async () => '' },
        snapshotChat: async () => over.state,
        readStreamedAnswer: async () => ({ found: false }),
        isGenerating: async () => false,
        isForeignBusy: async () => false,
        clickContinueIfPresent: async () => false,
        isTabGenerating: async () => false,
        selfHealDeadTab: async () => false,
        probeRendererAlive: async () => true,
        dropDeadRenderer: async () => 0,
        markProgress: () => {},
        quirk: () => false,
        looksLikeTruncatedAnswer: () => false,
        streamError: (t) => new Error('stream ' + t),
        RENDERER_DEAD_AFTER: 3,
        browserAlive: () => true,
        browser: {},
        ...(over.refs || {}),
    };
    const fn = new Function(...STUBS, extractFn('waitForResponse') + `\nreturn waitForResponse;`);
    return fn(...STUBS.map((n) => refs[n]));
}

const TAB_ANSWER = 'the finished answer already sitting on the tab';
const TAB_STATE = {
    mode: 'vl', count: 4, matchTotal: 2, answerIndex: 3, ids: [],
    text: TAB_ANSWER, answer: TAB_ANSWER, body: 'page body', lastCls: 'assistant',
};

test('the rescue path hands back the answer on the tab instead of throwing Timed out', async () => {
    // The bug is masked if any global named `state` happens to exist — a bare
    // out-of-scope `let` resolves to a global lookup, so a leaked global would make
    // the broken code look fixed. Assert the precondition explicitly.
    assert.strictEqual(typeof globalThis.state, 'undefined',
        'test precondition: no global `state` (it would mask the out-of-scope read)');

    const savedHardCap = process.env.HARD_CAP_MS;
    process.env.HARD_CAP_MS = String(Date.now() + 500);
    try {
        const waitForResponse = loadWaitForResponse({ state: TAB_STATE });
        const out = await waitForResponse(
            { mode: 'vl', count: 0, matchTotal: 0, text: '', answer: '' },
            'THE PROMPT WE TYPED'
        );
        assert.strictEqual(out, TAB_ANSWER,
            'an answer already on the tab at the deadline must be delivered, not discarded');
    } finally {
        if (savedHardCap === undefined) delete process.env.HARD_CAP_MS;
        else process.env.HARD_CAP_MS = savedHardCap;
    }
});

test('the count-mode rescue path is reachable too (it takes isForeignBusy, not isGenerating)', async () => {
    const savedHardCap = process.env.HARD_CAP_MS;
    process.env.HARD_CAP_MS = String(Date.now() + 500);
    const asked = { generating: 0, foreign: 0 };
    try {
        const waitForResponse = loadWaitForResponse({
            state: { ...TAB_STATE, mode: 'count' },
            refs: {
                isGenerating: async () => { asked.generating++; return false; },
                isForeignBusy: async () => { asked.foreign++; return false; },
            },
        });
        const out = await waitForResponse(
            { mode: 'count', count: 0, matchTotal: 0, text: '', answer: '' },
            'THE PROMPT WE TYPED'
        );
        assert.strictEqual(out, TAB_ANSWER);
        assert.ok(asked.foreign > 0,
            'a count-mode lane must ask isForeignBusy() for its busy signal');
        assert.strictEqual(asked.generating, 0,
            'isGenerating() is the vl-only signal and must not be used here');
    } finally {
        if (savedHardCap === undefined) delete process.env.HARD_CAP_MS;
        else process.env.HARD_CAP_MS = savedHardCap;
    }
});

test('the rescue loop does not spin: it settles on its first pass, not at the hard cap', async () => {
    const savedHardCap = process.env.HARD_CAP_MS;
    const started = Date.now();
    process.env.HARD_CAP_MS = String(Date.now() + 3000);
    let snapshots = 0;
    try {
        const waitForResponse = loadWaitForResponse({
            state: TAB_STATE,
            refs: { snapshotChat: async () => { snapshots++; return TAB_STATE; } },
        });
        const out = await waitForResponse(
            { mode: 'vl', count: 0, matchTotal: 0, text: '', answer: '' },
            'THE PROMPT WE TYPED'
        );
        assert.strictEqual(out, TAB_ANSWER);
        // 1 seed + 1 rescue poll. A ReferenceError on every pass shows up as dozens.
        assert.ok(snapshots <= 4,
            `rescue loop re-polled ${snapshots} times — it is failing and being swallowed, not rescuing`);
        assert.ok(Date.now() - started < 2500, 'rescue must settle immediately, not burn the hard cap');
    } finally {
        if (savedHardCap === undefined) delete process.env.HARD_CAP_MS;
        else process.env.HARD_CAP_MS = savedHardCap;
    }
});