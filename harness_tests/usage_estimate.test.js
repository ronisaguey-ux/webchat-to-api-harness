'use strict';
// Reported usage must reflect what was exchanged with the tab. Measured before this fix:
// a three-round tool turn reported `input_tokens: 0` and `output_tokens` = the CHARACTER
// count of the final answer; a round-budget failure reported no usage at all. A caller's
// token breaker summing these would never trip on a runaway loop.
process.env.MAX_TOOL_ROUNDS = '2';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const G = require('./_gateway');
const { FAKE_LOG } = require('../src/browser/browser');

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
test.after(() => G.stop());

const ANSWER = 'Read both files; nothing needed changing.';
const READ = (f) => G.call('read_file', { path: path.join(G.WORK, f) });
require('fs').writeFileSync(path.join(G.WORK, 'a.txt'), 'x'.repeat(4000));

test('anthropic: input and output are estimated from every send, not the answer length', async () => {
    const before = FAKE_LOG.sent.length;
    const replies = [READ('a.txt'), G.call('submit_answer', { text: ANSWER })];
    const r = await G.post('/v1/messages', { model: 'deepseek webchat', max_tokens: 50, messages: [{ role: 'user', content: 'check a.txt' }] }, replies);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    assert.strictEqual(r.headers.get('x-harness-usage-estimated'), 'chars/4');
    const sent = FAKE_LOG.sent.slice(before);
    assert.strictEqual(sent.length, 2);
    const u = r.json.usage;
    // The second send carries the 4000-char file, so input is well past 1000 tokens.
    assert.ok(u.input_tokens > 1000, `input_tokens ${u.input_tokens}`);
    assert.ok(u.input_tokens >= Math.ceil(sent.join('').length / 4), 'every send is counted');
    // Output is every reply the tab produced (both rounds), in chars/4 — not the
    // character count of the final answer.
    assert.strictEqual(u.output_tokens, Math.ceil(replies.join('').length / 4));
});

test('openai: prompt_tokens is nonzero and total adds up', async () => {
    const r = await G.post('/v1/chat/completions', { model: 'deepseek webchat', messages: [{ role: 'user', content: 'check a.txt' }] }, [
        READ('a.txt'),
        G.call('submit_answer', { text: ANSWER }),
    ]);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    const u = r.json.usage;
    assert.ok(u.prompt_tokens > 1000, JSON.stringify(u));
    assert.strictEqual(u.total_tokens, u.prompt_tokens + u.completion_tokens);
});

test('a round-budget failure still reports what it spent', async () => {
    const r = await G.post('/v1/messages', { model: 'deepseek webchat', max_tokens: 50, messages: [{ role: 'user', content: 'loop' }] }, [
        READ('a.txt'),
    ]);
    assert.strictEqual(r.status, 502, r.text.slice(0, 300));
    assert.ok(r.json.usage && r.json.usage.input_tokens > 1000, JSON.stringify(r.json).slice(0, 300));
});
