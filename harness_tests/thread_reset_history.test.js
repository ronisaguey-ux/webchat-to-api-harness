'use strict';
// When the gateway opens a fresh chat at a request boundary, the caller's earlier turns
// must reach it. Two faults, measured before this fix:
//   * the boundary reset never fired: handleRequest raised requestInFlight before calling
//     the check that refuses while it is set, so the tab thread grew without bound;
//   * with the order fixed, turn 1 ran two sends (a write and a submit), the reset fired
//     at the start of turn 2, and the fresh chat was sent ONLY "Now add tests for that." —
//     no trace of turn 1 — with nothing telling the caller.
process.env.NEW_CHAT_EVERY_SENDS = '2';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const G = require('./_gateway');
const { FAKE_LOG } = require('../src/browser/browser');

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
test.after(() => G.stop());

const TURN1 = 'Create util.py with an add(a, b) function.';
const REPLY1 = 'Created util.py with add(a, b).';

test('a thread reset replays the earlier turns and says so', async () => {
    const r1 = await G.post('/v1/chat/completions', { model: 'deepseek webchat', messages: [{ role: 'user', content: TURN1 }] }, [
        G.call('write_file', { path: path.join(G.WORK, 'util.py'), content: 'def add(a, b):\n    return a + b\n' }),
        G.call('submit_answer', { text: REPLY1 }),
    ]);
    assert.strictEqual(r1.status, 200, r1.text.slice(0, 300));
    assert.strictEqual(r1.headers.get('x-harness-thread-reset'), null, 'no reset on the first turn');

    const before = FAKE_LOG.sent.length;
    const r2 = await G.post('/v1/chat/completions', {
        model: 'deepseek webchat',
        messages: [
            { role: 'user', content: TURN1 },
            { role: 'assistant', content: REPLY1 },
            { role: 'user', content: 'Now add tests for that.' },
        ],
    }, [G.call('submit_answer', { text: 'I will add tests for add().' })]);
    assert.strictEqual(r2.status, 200, r2.text.slice(0, 300));
    assert.strictEqual(r2.headers.get('x-harness-thread-reset'), '1');
    const first = FAKE_LOG.sent[before];
    assert.ok(first.includes(TURN1), 'turn 1 was not replayed into the fresh chat');
    assert.ok(first.includes(REPLY1), 'the assistant reply was not replayed');
    assert.ok(first.indexOf(TURN1) < first.indexOf('Now add tests for that.'));
});

test('the transcript keeps the most recent turns within the budget', () => {
    const { historyTranscript } = G.server.__test;
    assert.strictEqual(historyTranscript([{ role: 'user', content: 'only' }]), '');
    const many = [];
    for (let i = 0; i < 40; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(900) });
    many.push({ role: 'user', content: 'latest' });
    const t = historyTranscript(many);
    assert.ok(t.includes('turn 39 '), 'the latest prior turn is kept');
    assert.ok(!t.includes('turn 0 '), 'the oldest are dropped first');
    assert.ok(!t.includes('latest'), 'the current message is not part of the history');
    assert.ok(t.length < 14000);
});
