'use strict';
//
// Two empty submit_answer calls must not become a success.
//
// Measured before this fix: the gateway answered HTTP 200 with the text
// "[webchat model completed the task]" — a completion claim the HARNESS wrote,
// standing in for an answer the model never gave.
//
const test = require('node:test');
const assert = require('node:assert');
const G = require('./_gateway');

test.after(() => G.stop());

const body = { model: 'deepseek webchat', max_tokens: 50, messages: [{ role: 'user', content: 'fix foo.py' }] };

test('an empty submit after the nudge is an error, not "completed the task"', async () => {
    const r = await G.post('/v1/messages', body, [G.call('submit_answer', { text: '' })]);
    assert.doesNotMatch(r.text, /completed the task/);
    assert.strictEqual(r.status, 502, r.text.slice(0, 200));
    assert.strictEqual(r.json.error.outcome, 'empty');
});

test('an empty submit followed by a real one returns the real answer', async () => {
    const r = await G.post('/v1/messages', { ...body, messages: [{ role: 'user', content: 'What is 2+2?' }] },
        [G.call('submit_answer', { text: '' }), G.call('submit_answer', { text: 'Four' })]);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.content[0].text, 'Four');
});
