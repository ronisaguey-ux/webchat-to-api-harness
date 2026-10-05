'use strict';
//
// A request that ends without a usable answer must reach the caller as an API
// ERROR, never as HTTP 200 + a "[⚠️ ...]" marker inside a normal completion.
//
// Measured before this fix, through the real HTTP surface: a model that never
// submits came back as 200 / stop_reason "end_turn" with the text
// "[⚠️ webchat model did not submit a final answer within the round budget]", so
// any caller that did not grep for that string recorded the step as done.
//
const test = require('node:test');
const assert = require('node:assert');
const G = require('./_gateway');

test.after(() => G.stop());

const anthropic = (extra = {}) => ({ model: 'deepseek webchat', max_tokens: 50, messages: [{ role: 'user', content: 'fix foo.py' }], ...extra });
const openai = (extra = {}) => ({ model: 'deepseek webchat', messages: [{ role: 'user', content: 'fix foo.py' }], ...extra });
// A model that keeps working and never submits: the round budget runs out.
const NEVER_SUBMITS = () => [G.call('list_dir', { path: G.WORK })];

test('round budget exhausted -> Anthropic 502 harness_incomplete, not 200', async () => {
    const r = await G.post('/v1/messages', anthropic(), NEVER_SUBMITS());
    assert.strictEqual(r.status, 502, r.text.slice(0, 200));
    assert.strictEqual(r.json.type, 'error');
    assert.strictEqual(r.json.error.type, 'harness_incomplete');
    assert.strictEqual(r.json.error.outcome, 'round_budget');
    assert.strictEqual(r.headers.get('x-harness-outcome'), 'round_budget');
});

test('round budget exhausted -> OpenAI 502, never finish_reason stop', async () => {
    const r = await G.post('/v1/chat/completions', openai(), NEVER_SUBMITS());
    assert.strictEqual(r.status, 502, r.text.slice(0, 200));
    assert.strictEqual(r.json.error.type, 'harness_incomplete');
    assert.strictEqual(r.json.error.code, 'round_budget');
    assert.ok(!r.json.choices, 'no completion body on a failure');
});

test('round budget exhausted on a stream -> stop_reason "error", never "end_turn"', async () => {
    const r = await G.post('/v1/messages', anthropic({ stream: true }), NEVER_SUBMITS());
    assert.match(r.text, /"stop_reason":"error"/);
    assert.doesNotMatch(r.text, /"stop_reason":"end_turn"/);
    assert.match(r.text, /harness_incomplete/);
    assert.match(r.text, /event: message_stop/);
});

test('a model that never emits tool JSON -> 502, not a 200 marker', async () => {
    const r = await G.post('/v1/messages', anthropic(), ['I will now look at the files and fix them.']);
    assert.strictEqual(r.status, 502, r.text.slice(0, 200));
    assert.ok(['no_tool_json', 'round_budget'].includes(r.json.error.outcome), r.json.error.outcome);
    assert.doesNotMatch(r.text, /"stop_reason":"end_turn"/);
});

test('a real answer is still a normal 200 completion', async () => {
    const r = await G.post('/v1/messages', anthropic({ messages: [{ role: 'user', content: 'What is 2+2?' }] }),
        [G.call('submit_answer', { text: 'Four' })]);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.stop_reason, 'end_turn');
    assert.strictEqual(r.json.content[0].text, 'Four');
    assert.strictEqual(r.headers.get('x-harness-outcome'), 'ok');
});
