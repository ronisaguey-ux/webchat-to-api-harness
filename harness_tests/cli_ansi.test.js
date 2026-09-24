'use strict';
// ansi.js formatter tests (2026-09-22).
//
// The interactive primitives need a TTY, but the FORMATTING does not — and the
// formatting is where the bugs actually were: `visibleWidth` counting escape
// bytes, `truncate` slicing a coloured string mid-escape, `boxLines` miscounting
// its right border by one. Every case below was a real mistake in an earlier
// draft of the toolkit.
const test = require('node:test');
const assert = require('node:assert');

// Force colour on so the escape handling is exercised regardless of how the
// suite is invoked. NO_COLOR/CI would otherwise make half these cases vacuous.
process.env.FORCE_COLOR = '1';
const A = require('../cli/ansi.js');

test('visibleWidth ignores ANSI escapes', () => {
    assert.strictEqual(A.visibleWidth('abc'), 3);
    assert.strictEqual(A.visibleWidth('\u001b[31mabc\u001b[0m'), 3);
    assert.strictEqual(A.visibleWidth(A.bold(A.green('abc'))), 3);
    assert.strictEqual(A.visibleWidth(''), 0);
});

test('pad aligns on VISIBLE width, not byte length', () => {
    const coloured = '\u001b[31mab\u001b[0m';   // 2 visible, 11 bytes
    assert.strictEqual(A.visibleWidth(A.pad(coloured, 6)), 6);
    assert.strictEqual(A.visibleWidth(A.pad(coloured, 6, 'right')), 6);
    assert.strictEqual(A.visibleWidth(A.pad(coloured, 6, 'center')), 6);
    // Never negative when the content is already wider.
    assert.strictEqual(A.pad('abcdef', 3), 'abcdef');
});

test('truncate never slices inside an escape sequence', () => {
    const coloured = '\u001b[31mabcdefghij\u001b[0m';
    const cut = A.truncate(coloured, 5);
    assert.ok(A.visibleWidth(cut) <= 5, `visible width ${A.visibleWidth(cut)} must be <= 5`);
    assert.ok(!/\u001b\[[0-9;]*$/.test(cut), 'must not end on a half-written escape');
    assert.ok(cut.endsWith('…') || cut.includes('…'));
    // Short enough strings pass through untouched.
    assert.strictEqual(A.truncate('abc', 10), 'abc');
});

test('wrap breaks on words and never returns an empty list', () => {
    assert.deepStrictEqual(A.wrap('one two three', 8), ['one two', 'three']);
    assert.deepStrictEqual(A.wrap('', 10), ['']);
    assert.deepStrictEqual(A.wrap('   ', 10), ['']);
    // A single word longer than the width is emitted whole rather than dropped.
    assert.deepStrictEqual(A.wrap('supercalifragilistic', 5), ['supercalifragilistic']);
});

test('boxLines draws a closed box whose lines are all the same visible width', () => {
    const lines = A.boxLines('Title', ['hello', '', 'a much longer line that must wrap around the box edge'], { width: 30 });
    for (const l of lines) {
        assert.strictEqual(A.visibleWidth(l), 30, `ragged line: ${JSON.stringify(l)}`);
    }
    assert.ok(lines[0].startsWith('┌'));
    assert.strictEqual(lines[lines.length - 1][0], '└');
    assert.strictEqual(lines[lines.length - 1].slice(-1), '┘');
    // Everything is bordered.
    for (const l of lines.slice(1, -1)) {
        assert.strictEqual(l[0], '│');
        assert.strictEqual(l.slice(-1), '│');
    }
});

test('boxLines survives a width too small to hold the title', () => {
    // The title has to be truncated rather than producing a negative repeat count.
    const lines = A.boxLines('a very long title indeed', ['x'], { width: 20 });
    for (const l of lines) assert.strictEqual(A.visibleWidth(l), 20);
});

test('boxLines renders an untitled box', () => {
    const lines = A.boxLines('', ['body'], { width: 24 });
    assert.ok(lines[0].startsWith('┌'));
    assert.strictEqual(A.visibleWidth(lines[0]), 24);
});

test('termWidth uses the whole terminal, with a small margin, and a configurable cap', () => {
    const saved = { columns: process.stdout.columns, COLUMNS: process.env.COLUMNS, max: process.env.WEBCHAT_UI_MAX_WIDTH, margin: process.env.WEBCHAT_UI_MARGIN };
    try {
        delete process.env.WEBCHAT_UI_MAX_WIDTH;
        delete process.env.WEBCHAT_UI_MARGIN;

        // Narrow terminals keep a floor so the layout cannot collapse.
        process.stdout.columns = 10;
        assert.strictEqual(A.termWidth(), 40, 'never narrower than 40');

        // A wide terminal is USED. The old clamp of 140 left a narrow strip of box in
        // the middle of an empty screen, which is the complaint this changed for.
        process.stdout.columns = 1000;
        assert.strictEqual(A.termWidth(), 996, 'the default margin is 2 columns each side, not a 140 clamp');

        // The cap still exists — as a setting, for someone who wants it.
        process.env.WEBCHAT_UI_MAX_WIDTH = '140';
        assert.strictEqual(A.termWidth(), 140, 'an explicit cap is honoured');

        // And the margin is a setting too: 0 means truly full width.
        delete process.env.WEBCHAT_UI_MAX_WIDTH;
        process.env.WEBCHAT_UI_MARGIN = '0';
        assert.strictEqual(A.termWidth(), 1000, 'margin 0 spans the whole terminal');

        // COLUMNS is still read when the stream reports nothing.
        delete process.env.WEBCHAT_UI_MARGIN;
        delete process.stdout.columns;
        process.env.COLUMNS = '72';
        assert.strictEqual(A.termWidth(), 68, '72 minus the default 2-column margin each side');
    } finally {
        if (saved.columns !== undefined) process.stdout.columns = saved.columns;
        if (saved.COLUMNS === undefined) delete process.env.COLUMNS; else process.env.COLUMNS = saved.COLUMNS;
        if (saved.max === undefined) delete process.env.WEBCHAT_UI_MAX_WIDTH; else process.env.WEBCHAT_UI_MAX_WIDTH = saved.max;
        if (saved.margin === undefined) delete process.env.WEBCHAT_UI_MARGIN; else process.env.WEBCHAT_UI_MARGIN = saved.margin;
    }
});

test('NO_COLOR produces clean text with no escapes at all', () => {
    // Re-required in a child so the module-level colour decision re-evaluates.
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-e', [
        'delete process.env.FORCE_COLOR;',
        'process.env.NO_COLOR = "1";',
        'const A = require("' + require.resolve('../cli/ansi.js') + '");',
        'process.stdout.write(A.bold("bold") + "|" + A.red("red") + "|" + A.cyan("cyan"));',
    ].join('')], { encoding: 'utf-8' });
    assert.strictEqual(out, 'bold|red|cyan');
    assert.ok(!out.includes('\u001b'), 'no escape sequences when NO_COLOR is set');
});

test('screen control writes nothing when stdout is not a TTY', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-e', [
        'delete process.env.FORCE_COLOR;',
        'process.env.NO_COLOR = "1";',
        'const A = require("' + require.resolve('../cli/ansi.js') + '");',
        'A.clear(); A.hideCursor(); A.showCursor(); A.home();',
        'process.stdout.write("clean");',
    ].join('')], { encoding: 'utf-8' });
    assert.strictEqual(out, 'clean',
        'piped output must not contain a clear-screen or cursor escape');
});
