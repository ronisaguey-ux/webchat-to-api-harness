'use strict';
//
// wrap() must measure VISIBLE width, not string length.
//
// The live dashboard rendered an 80-column box whose hint broke onto a second line
// with room to spare. Cause: the string carries ANSI colour codes and wrap compared
// raw `.length`, so every escape byte counted as a character — a bold label measured
// 26 instead of 17. A test using plain strings passes against the broken version, so
// every case here carries colour on purpose.
//
const test = require('node:test');
const assert = require('node:assert');
const A = require('../cli/ansi.js');

const BOLD = '\u001b[1m';
const RESET = '\u001b[22m';
const GRAY = '\u001b[90m';
const GRAY_OFF = '\u001b[39m';
const CYAN = '\u001b[36m';
const CYAN_OFF = '\u001b[39m';

test('a coloured line wraps exactly like its plain twin', () => {
    const plain = '❯ Webchat & browser  pick the site, launch it, log in, connect';
    const coloured = `${CYAN}❯${CYAN_OFF} ${BOLD}Webchat & browser${RESET} ${GRAY} pick the site, launch it, log in, connect${GRAY_OFF}`;
    assert.strictEqual(A.wrap(plain, 76).length, 1);
    assert.strictEqual(A.wrap(coloured, 76).length, 1);
});

test('an escape sequence costs zero width', () => {
    // 20 visible chars of text wrapped in colour, against a width of exactly 20.
    const s = `${BOLD}${'x'.repeat(20)}${RESET}`;
    assert.strictEqual(A.visibleWidth(s), 20);
    assert.strictEqual(A.wrap(s, 20).length, 1, 'colour must not force a wrap at the exact boundary');
});

test('a coloured word that genuinely overflows still wraps', () => {
    // Non-vacuity the other way: the fix must not disable wrapping altogether.
    // "alpha beta gamma" is 16 visible against a width of 12, so it breaks after
    // "beta" — 10, not 11: the space that separated it from "gamma" is where the
    // break happened, so it is not retained on the first line.
    const s = `${BOLD}alpha${RESET} ${GRAY}beta${GRAY_OFF} ${BOLD}gamma${RESET}`;
    const lines = A.wrap(s, 12);
    assert.strictEqual(lines.length, 2, 'must still wrap when the text really is too long');
    assert.deepStrictEqual(lines.map((l) => A.visibleWidth(l)), [10, 5]);
    assert.ok(A.visibleWidth(lines[0]) <= 12);
});

test('runs of whitespace are preserved, not collapsed', () => {
    // The menu relies on a two-space gap between label and hint.
    const s = 'label  hint';
    assert.deepStrictEqual(A.wrap(s, 40), ['label  hint']);
});

test('trailing whitespace never causes a wrap on its own', () => {
    // "ab " is exactly at the boundary if the trailing space counted; it must not.
    const s = 'ab cd ';
    assert.deepStrictEqual(A.wrap(s, 5), ['ab cd']);
});
