'use strict';
// A subagent job is `done` only when the gateway actually produced an answer. A 200 that
// carries a non-ok X-Harness-Outcome, a whitespace-only answer, or an older gateway's
// "[⚠️ …]" marker text is a failure — the job must say `failed`, not hand the marker to
// the caller as if it were the result.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-outcome-'));
const WORKER = path.join(__dirname, '..', 'src', 'runtime', 'subagent-run.js');
let server, port, reply;

test.before(async () => {
    server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, reply.headers || {}));
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.content } }] }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
});
test.after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

let n = 0;
async function runJob(r) {
    reply = r;
    const id = `t${process.pid}x${n++}`;
    const dir = path.join(ROOT, 'state', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const job = {
        id, gate: 'deepseek', prompt: 'do the thing', state: 'running', timeoutMs: 20000,
        resultFile: path.join(dir, `${id}.result.txt`), errorFile: path.join(dir, `${id}.error.txt`),
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(job));
    // spawnSync would block the event loop the fake gateway runs on, so await the child.
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
        const c = spawn(process.execPath, [WORKER, id], {
            env: { ...process.env, WORKSPACE_ROOT: ROOT, HARNESS_AGGREGATE_URL: `http://127.0.0.1:${port}` },
            stdio: 'ignore',
        });
        c.on('exit', resolve);
    });
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
}

test('a real answer is done', async () => {
    const j = await runJob({ content: 'The answer is 42.', headers: { 'x-harness-outcome': 'ok' } });
    assert.strictEqual(j.state, 'done');
});

test('a non-ok X-Harness-Outcome fails the job even on 200', async () => {
    const j = await runJob({ content: 'partial text', headers: { 'x-harness-outcome': 'round_budget' } });
    assert.strictEqual(j.state, 'failed');
    assert.match(j.error, /round_budget/);
});

test('a legacy marker answer fails the job', async () => {
    const j = await runJob({ content: '[⚠️ Harness stopped: tool-round budget (8) exhausted before a final answer.]' });
    assert.strictEqual(j.state, 'failed');
});

test('a whitespace-only answer fails the job', async () => {
    const j = await runJob({ content: '  \n\t ' });
    assert.strictEqual(j.state, 'failed');
});
