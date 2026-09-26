'use strict';
// search_web is a paid call. Measured before this fix: nothing bounded how many were
// made (20 calls in a row all went out, with the ledger already far past $2 for the
// hour), and an empty search came back success:true, so the model went on to answer
// "from sources" it never received.
//
// fetch is stubbed: nothing here reaches the network, and the key is a fake string set
// only in this process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-spend-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
process.env.SPEND_LEDGER_FILE = path.join(TMP, 'spend.json');
process.env.PAID_SPEND_HOUR_USD = '2';
process.env.PAID_SPEND_DAY_USD = '10';

const tools = require('../src/tools/tools');
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');

const calls = [];
let reply = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), key: init.headers['x-api-key'] });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
};
test.after(() => { globalThis.fetch = realFetch; fs.rmSync(TMP, { recursive: true, force: true }); });

const HIT = {
    content: [
        { type: 'web_search_tool_result', content: [{ title: 'T', url: 'https://example.org', text: 'x' }] },
        { type: 'text', text: 'The answer, per example.org.' },
    ],
    // 200K output tokens: a deliberately expensive call (~$0.41), so the cap is reached in a few.
    usage: { input_tokens: 1000, output_tokens: 200000, server_tool_use: { web_search_requests: 1 } },
};

test('a search goes to the flash model at the DeepSeek host', async () => {
    reply = HIT;
    const r = await tools.executeTool('search_web', { query: 'q' });
    assert.strictEqual(r.success, true, JSON.stringify(r));
    const c = calls.at(-1);
    assert.strictEqual(new URL(c.url).host, 'api.deepseek.com');
    assert.strictEqual(c.body.model, 'deepseek-v4-flash');
});

test('an empty search is a failure, not a success', async () => {
    reply = { content: [{ type: 'text', text: '' }], usage: { input_tokens: 10, output_tokens: 1 } };
    const r = await tools.executeTool('search_web', { query: 'nothing' });
    assert.strictEqual(r.success, false, JSON.stringify(r));
    assert.match(r.error, /no results/);
});

test('the hourly cap stops paid calls before they are made', async () => {
    reply = HIT;
    let refused = null;
    for (let i = 0; i < 20; i++) {
        const r = await tools.executeTool('search_web', { query: 'again ' + i });
        if (!r.success) { refused = { i, r }; break; }
    }
    assert.ok(refused, 'twenty expensive searches in an hour were all made');
    assert.match(refused.r.error, /budget_exhausted/);
    const before = calls.length;
    const again = await tools.executeTool('search_web', { query: 'one more' });
    assert.strictEqual(again.success, false);
    assert.strictEqual(calls.length, before, 'a refused search must not reach the API');
});

test('the ledger persists, so a restart does not reset the cap', () => {
    const SPEND = require('../src/runtime/spend_ledger');
    const t = SPEND.totals();
    assert.ok(t.hourUsd >= 2, JSON.stringify(t));
    assert.ok(fs.existsSync(process.env.SPEND_LEDGER_FILE));
});
