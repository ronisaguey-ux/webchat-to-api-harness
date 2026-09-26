'use strict';
//
// The phantom-completion guard must count what SUCCEEDED, not what was attempted,
// and must check a "tests pass" claim against the tests that actually ran.
//
// Measured before this fix, through the real loop:
//   * every write refused by the sandbox, then "Implemented the fix and updated
//     foo.py" -> HTTP 200, unmarked (mutationsRun counted the refused attempts);
//   * a test command that exited 1, then "all tests pass" -> HTTP 200, unmarked.
//
process.env.BASH_ALLOWED = 'true';
process.env.SANDBOX_ALLOW_BASH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const G = require('./_gateway');

test.after(() => G.stop());

const body = (prompt) => ({ model: 'deepseek webchat', max_tokens: 50, messages: [{ role: 'user', content: prompt }] });
const OUTSIDE = '/etc/harness-guard-test-foo.py'; // outside the sandbox root: always refused

test('refused writes then "implemented and updated" -> unverified error', async () => {
    const r = await G.post('/v1/messages', body('fix foo.py'), [
        G.call('write_file', { path: OUTSIDE, content: 'x = 1\n' }),
        G.call('edit_file', { path: OUTSIDE, old_string: 'x', new_string: 'y' }),
        G.call('submit_answer', { text: 'Implemented the fix and updated foo.py.' }),
    ]);
    assert.strictEqual(r.status, 502, r.text.slice(0, 300));
    assert.strictEqual(r.json.error.outcome, 'unverified');
});

test('a failing test run then "all tests pass" -> unverified error', async () => {
    const failing = path.join(G.WORK, 'failing.test.js');
    // NODE_TEST_CONTEXT is inherited from this runner and makes a nested
    // `node --test` report to it and exit 0 — clear it so the exit code is real.
    fs.writeFileSync(failing, "require('node:test')('x', () => { throw new Error('boom'); });\n");
    const r = await G.post('/v1/messages', body('make the tests pass'), [
        G.call('run_bash', { command: `env -u NODE_TEST_CONTEXT node --test ${failing}` }),
        G.call('submit_answer', { text: 'Fixed it; all tests pass now.' }),
    ]);
    assert.strictEqual(r.status, 502, r.text.slice(0, 300));
    assert.strictEqual(r.json.error.outcome, 'unverified');
    assert.match(r.json.error.message, /last test command in this turn FAILED/);
});

test('a real write and a passing test run -> a normal answer', async () => {
    const target = path.join(G.WORK, 'ok.test.js');
    const r = await G.post('/v1/messages', body('add a test'), [
        G.call('write_file', { path: target, content: "require('node:test')('ok', () => {});\n" }),
        G.call('run_bash', { command: `env -u NODE_TEST_CONTEXT node --test ${target}` }),
        G.call('submit_answer', { text: 'Wrote ok.test.js; the tests pass.' }),
    ]);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    assert.strictEqual(r.json.content[0].text, 'Wrote ok.test.js; the tests pass.');
});

test('the test-command and tests-pass detectors', () => {
    const { TEST_COMMAND_RE, claimsTestsPass } = G.server.__test;
    for (const c of ['pytest -q', 'cd x && python -m pytest tests', 'npm test', 'node --test a.test.js', 'cargo test']) {
        assert.ok(TEST_COMMAND_RE.test(c), c);
    }
    for (const c of ['ls', 'cat pytest.ini', 'git log']) assert.ok(!TEST_COMMAND_RE.test(c), c);
    assert.ok(claimsTestsPass('all tests pass'));
    assert.ok(claimsTestsPass('The suite is green.'));
    assert.ok(!claimsTestsPass('Paris is the capital of France.'));
});
