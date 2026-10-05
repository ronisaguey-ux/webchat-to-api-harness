'use strict';
// The "🔧 Executing" log line printed every tool's arguments whole. Measured before this
// fix: write_file of a .env put `OPENAI_API_KEY=sk-…` and the whole body in the log, and
// a run_bash carrying a token printed it verbatim. The values below are fake.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-redact-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
process.env.SANDBOX_ROOTS = TMP;
const tools = require('../src/tools/tools');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function logged(tool, args) {
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { await tools.executeTool(tool, args); } finally { console.log = real; }
    return lines.filter((l) => l.includes('Executing')).join('\n');
}

const FAKE_SK = 'sk-FAKE0123456789abcdefFAKE';

test('a file body never reaches the log, only its size', async () => {
    const body = `OPENAI_API_KEY=${FAKE_SK}\nDB_PASSWORD=hunter2hunter2\n` + 'x'.repeat(5000);
    const line = await logged('write_file', { path: path.join(TMP, '.env'), content: body });
    assert.ok(line.includes('write_file'), line);
    assert.ok(!line.includes(FAKE_SK), 'the key was logged');
    assert.ok(!line.includes('hunter2'), 'the password was logged');
    assert.match(line, new RegExp(`<${body.length} chars>`));
    assert.ok(line.length < 500, `log line is ${line.length} chars`);
});

test('token shapes and secret-named keys are masked anywhere', () => {
    const r = tools.redactArgs({
        command: `curl -H "Authorization: Bearer ${FAKE_SK}" https://x`,
        api_key: 'plain-value',
        nested: { token: 'abc', note: 'ghp_FAKEFAKEFAKEFAKE1234' },
        path: '/tmp/a.txt',
    });
    const j = JSON.stringify(r);
    assert.ok(!j.includes(FAKE_SK) && !j.includes('plain-value') && !j.includes('ghp_FAKE'), j);
    assert.strictEqual(r.path, '/tmp/a.txt', 'ordinary arguments are kept');
});
