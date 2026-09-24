'use strict';
//
// parseToolCalls must accept BOTH argument shapes.
//
// Measured failure: the Gemini lane emitted every tool call in the FLAT form
//     {"tool":"git_status","repo":"helpotron"}
// while the parser required `params`, so each call was rejected, a correction was
// sent, the model retried in the same shape, the rounds burned, and it eventually
// submitted a fabricated summary. The log said only "malformed tool JSON", which
// is indistinguishable from a model that cannot produce valid output — so this
// looked like model flakiness for a whole debugging session.
//
const test = require('node:test');
const assert = require('node:assert');
const { parseToolCalls } = require('../src/tools/tools.js');

test('the flat form is accepted (this was the bug)', () => {
    const r = parseToolCalls('{"tool":"git_status","repo":"helpotron"}');
    assert.strictEqual(r.toolCalls.length, 1);
    assert.deepStrictEqual(r.toolCalls[0], {
        toolName: 'git_status',
        args: { repo: 'helpotron' },
    });
});

test('the nested form still works', () => {
    const r = parseToolCalls('{"tool":"read_file","params":{"path":"/tmp/x"}}');
    assert.deepStrictEqual(r.toolCalls[0], {
        toolName: 'read_file',
        args: { path: '/tmp/x' },
    });
});

test('the exact string the model produced parses, prose included', () => {
    const raw = '💬 Checking git status of the helpotron repo to understand the current workspace state. JSON {"tool":"git_status","repo":"helpotron"}';
    const r = parseToolCalls(raw);
    assert.strictEqual(r.toolCalls.length, 1, 'a valid call must never be rejected as malformed');
    assert.strictEqual(r.toolCalls[0].toolName, 'git_status');
    assert.strictEqual(r.toolCalls[0].args.repo, 'helpotron');
});

test("the renderer's JSON label is not left in the prose", () => {
    const raw = '💬 Checking git status. JSON {"tool":"git_status","repo":"helpotron"}';
    const r = parseToolCalls(raw);
    assert.ok(!/json/i.test(r.prose), `prose still carries the label: ${JSON.stringify(r.prose)}`);
    assert.match(r.prose, /Checking git status/);
});

test('a scalar `params` string reads as the text argument', () => {
    const r = parseToolCalls('{"tool":"submit_answer","params":"the answer"}');
    assert.deepStrictEqual(r.toolCalls[0].args, { text: 'the answer' });
});

test('flat submit_answer works', () => {
    const r = parseToolCalls('{"tool":"submit_answer","text":"done"}');
    assert.deepStrictEqual(r.toolCalls[0].args, { text: 'done' });
});

test('a flat call with NO args yields an empty args object, not undefined', () => {
    // An empty object keeps every downstream `args.x` safe; undefined would throw in
    // the tool executors, turning "no arguments" into a crash.
    const r = parseToolCalls('{"tool":"get_time"}');
    assert.strictEqual(r.toolCalls.length, 1);
    assert.deepStrictEqual(r.toolCalls[0].args, {});
});

test('being liberal did not break rejection of non-tool JSON', () => {
    // A plain JSON blob with no tool/name key is NOT a tool call. This is the
    // boundary that keeps the parser from treating any brace as an instruction.
    for (const s of ['{"result":42}', '{"status":"ok","items":[1,2]}', '{"json":true}']) {
        assert.strictEqual(parseToolCalls(s).toolCalls.length, 0, `should not parse: ${s}`);
    }
});
