'use strict';
//
// The 2026-09-23 phantom: a run made 25 READ-ONLY calls (read_file, see_next_chunk,
// list_dir, run_bash pytest/git-status/vite-build) and submitted:
//
//   "All remediation steps across the three repositories have been successfully
//    executed, tested, and verified ... session tokens hashed, cost routes guarded,
//    changes committed and pushed."
//
// `git log` showed no commit in either repo, no such code existed, and no file had
// changed. `workToolsRun` was 25, so the zero-tool guard passed it straight through —
// reading a repository is not evidence that anything in it changed.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-mut-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');

const { __test } = require(path.join(__dirname, '..', 'server.js'));
const { markUnverifiedSubmit } = __test;

const PHANTOM =
    'All remediation steps across the three repositories (t2b, helpotron, and harness) have been ' +
    'successfully executed, tested, and verified. Session tokens hashed, cost routes guarded, ' +
    'changes committed and pushed.';

test('a claim of changes after ONLY reads is marked', () => {
    // 25 read-only calls, no mutation — the exact shape of the run that lied.
    const v = markUnverifiedSubmit(PHANTOM, { offeredWorkTools: true, workToolsRun: 25, mutationsRun: 0 });
    assert.strictEqual(v.marked, true, 'read-only work must not certify a change');
    assert.match(v.text, /no file was written and no command was run that changes anything/);
    assert.match(v.text, /All remediation steps/, 'the original answer must still be readable');
});

test('the same claim is NOT marked once a mutation ran', () => {
    // Correction, and the reason this must not be a blanket warning: an agent that
    // wrote a file and then reports it is telling the truth.
    const v = markUnverifiedSubmit(PHANTOM, { offeredWorkTools: true, workToolsRun: 25, mutationsRun: 1 });
    assert.strictEqual(v.marked, false);
    assert.strictEqual(v.text, PHANTOM, 'the text must be untouched');
});

test('an honest read-only answer is left alone', () => {
    // "I read the plan and here is what it says" asserts no change. The guard is about
    // claims of CHANGE, not about whether the model typed the word "done".
    const readOnly = 'I reviewed the plan and the harness. The gateway compacts tool results and the suite passes.';
    const v = markUnverifiedSubmit(readOnly, { offeredWorkTools: true, workToolsRun: 25, mutationsRun: 0 });
    assert.strictEqual(v.marked, false, 'a read-only report makes no claim that needs evidence');
});

test('the zero-tool case still works', () => {
    const v = markUnverifiedSubmit('All steps completed and verified.', { offeredWorkTools: true, workToolsRun: 0, mutationsRun: 0 });
    assert.strictEqual(v.marked, true);
    assert.match(v.text, /no tools were run in this turn/);
});

test('a caller that does not pass the counts behaves as before', () => {
    // mutationsRun defaults to null, and null !== 0, so the new branch cannot fire for
    // a caller that predates it. Backwards compatible by construction, not by luck.
    const v = markUnverifiedSubmit(PHANTOM, { offeredWorkTools: true, workToolsRun: 25 });
    assert.strictEqual(v.marked, false);
});
