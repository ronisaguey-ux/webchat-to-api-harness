'use strict';
//
// The agentic-harness screen toggles a row on Enter and then re-draws the SAME list.
// Re-entering the menu at index 0 made every Enter snap back to the first row, which
// reads as "the selection did not work". menu() therefore takes startIndex, and this
// pins that behaviour.
//
// Run: node --test harness_tests/menu_cursor.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const A = require(path.join(__dirname, '..', 'cli', 'ansi.js'));

// Drive the menu by replacing stdin with a stub that replays key bytes. readKey()
// reads process.stdin, so the stub is enough to run the real menu loop.
function withKeys(keys, fn) {
    const { Readable } = require('stream');
    const desc = Object.getOwnPropertyDescriptor(process, 'stdin');
    const seq = Buffer.from(keys.join(''), 'utf8');
    let sent = false;
    // Push from inside read(), which the stream only calls once something is
    // consuming it — a timer would race the listener and drop keys intermittently
    // (measured: 3/4 one run, 4/4 the next).
    const fake = new Readable({
        read() {
            if (sent) return;
            sent = true;
            this.push(seq);
            this.push(null);
        },
    });
    fake.isTTY = true;
    fake.isRaw = false;
    fake.setRawMode = () => {};
    fake.pause = () => {};
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
    return Promise.resolve(fn()).finally(() => { Object.defineProperty(process, 'stdin', desc); });
}

const ITEMS = [
    { label: 'aider', value: 'aider' },
    { label: 'claude', value: 'claude' },
    { label: 'opencode', value: 'opencode' },
    { label: 'codex', value: 'codex' },
];

test('startIndex puts the cursor on that row, so an immediate Enter returns it', async () => {
    const got = await withKeys(['\r'], () => A.menu(ITEMS, { startIndex: 2, width: 60 }));
    assert.strictEqual(got, 'opencode', 'Enter must return the row the cursor is on');
});

test('without startIndex the cursor starts at the top (unchanged default)', async () => {
    const got = await withKeys(['\r'], () => A.menu(ITEMS, { width: 60 }));
    assert.strictEqual(got, 'aider');
});

test('an out-of-range startIndex falls back to the first row, never throws', async () => {
    for (const bad of [-1, 99, 1.5, null, undefined, 'x']) {
        const got = await withKeys(['\r'], () => A.menu(ITEMS, { startIndex: bad, width: 60 }));
        assert.strictEqual(got, 'aider', `startIndex=${String(bad)} should fall back`);
    }
});

test('arrows still move from the startIndex, so navigation is unaffected', async () => {
    const got = await withKeys(['\u001b[B', '\r'], () => A.menu(ITEMS, { startIndex: 1, width: 60 }));
    assert.strictEqual(got, 'opencode', 'one down from index 1 is index 2');
});
