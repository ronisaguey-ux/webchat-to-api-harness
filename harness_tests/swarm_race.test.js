'use strict';
//
// raceSwarm must return the first SUCCESSFUL lane, as soon as it answers.
//
// Before this fix: it awaited every lane (Promise.all), then picked the lowest
// elapsedMs across ALL results — failures included. A lane that failed fast "won"
// against a slower correct answer, so winner came back null although a lane had
// succeeded, and a 200 carrying an empty answer counted as ok.
//
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// A fake aggregate: each model alias behaves like one lane.
const LANES = {
    ds: { delay: 20, status: 502, body: { error: { message: 'lane down' } } },          // fast failure
    gm: { delay: 400, status: 200, body: { choices: [{ message: { content: 'Paris' } }] } }, // slow success
    cg: { delay: 3000, status: 200, body: { choices: [{ message: { content: 'late' } }] } },  // slowest
    empty: { delay: 10, status: 200, body: { choices: [{ message: { content: '   ' } }] } },    // fast, empty
};
let server;
test.before(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET') { // /health: every lane has a live browser
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, browserAlive: true }));
        }
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            const lane = LANES[JSON.parse(raw).model];
            setTimeout(() => {
                if (res.destroyed) return;
                res.writeHead(lane.status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(lane.body));
            }, lane.delay);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    process.env.HARNESS_AGGREGATE_URL = `http://127.0.0.1:${port}`;
    // The public entry point reads the gate registry; point it at a temp one.
    process.env.WEBCHAT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-swarm-'));
    fs.writeFileSync(path.join(process.env.WEBCHAT_STATE_DIR, 'gates.json'), JSON.stringify({
        gates: ['deepseek', 'gemini', 'chatgpt', 'empty'].map((id) => ({ id, gatewayPort: port })),
    }));
});
test.after(() => server.close());

const { raceSwarm } = require('../src/runtime/swarm');
const race = (gates) => raceSwarm({ prompt: 'capital of France?', gates, timeoutMs: 10000 });

test('a fast failure does not beat a slower success', async () => {
    const r = await race(['deepseek', 'gemini']);
    assert.strictEqual(r.winner, 'gemini');
    assert.strictEqual(r.answer, 'Paris');
});

test('a fast empty 200 is not a win', async () => {
    const r = await race(['empty', 'gemini']);
    assert.strictEqual(r.winner, 'gemini');
    assert.strictEqual(r.results.find((x) => x.lane === 'empty').ok, false);
});

test('the race returns at the first success, not after the slowest lane', async () => {
    const t0 = Date.now();
    const r = await race(['gemini', 'chatgpt']);
    assert.strictEqual(r.winner, 'gemini');
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms — waited for the 3s lane`);
});

test('no lane succeeds -> winner null', async () => {
    const r = await race(['deepseek', 'empty']);
    assert.strictEqual(r.winner, null);
});
