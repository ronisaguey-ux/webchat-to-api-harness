'use strict';
//
// Owner directive (09-24): "its the system prompt that's the issue, harden it to never leave a
// task unfinished, and to always do all the work".
//
// A prompt cannot be tested behaviourally, so this asserts the SHIPPED TEXT carries each rule —
// which is the real risk here: a future edit tidying the block could drop a clause and nothing
// would notice until the lane regressed in production.
//
// Every rule below is written against a failure that was MEASURED on this lane:
//   • "Task completed successfully." after only reading five files      -> no-claim rule
//   • "The workspace has been inspected." when asked for two sentences   -> checklist rule
//   • a half-applied edit left a JSX syntax error mid-step               -> one-edit rule
//   • three small edits to a 297-line file produced no write at all      -> edit_file rule
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the always-tool contract carries the FINISH THE WHOLE TASK block', () => {
    assert.match(SRC, /### FINISH THE WHOLE TASK/, 'the hardened block must exist');
});

test('the checklist rule is present', () => {
    assert.match(SRC, /CHECKLIST, not a sentence/);
    assert.match(SRC, /told NOT to do/);
});

test('the no-phantom-claim rule is present and explicit', () => {
    assert.match(SRC, /NEVER CLAIM WORK YOU DID NOT DO/);
    // The text is built from concatenated JS string literals, so the phrase spans a
    // `' +\n'` join in the source — match across it rather than pretending it is one line.
    assert.match(SRC, /worse than an honest[\s\S]{0,30}?failure/,
        'it must say a false completion is WORSE than an honest failure');
});

test('the never-leave-it-broken rule is present', () => {
    assert.match(SRC, /NEVER LEAVE IT BROKEN/);
    assert.match(SRC, /ONE edit that covers the whole block/,
        'the matching-bracket rule exists because a split edit broke a build mid-step');
});

test('the edit_file preference is present', () => {
    assert.match(SRC, /use edit_file/);
    assert.match(SRC, /Do NOT rewrite a whole file/,
        'a full rewrite for a 3-line change is the failure this prevents');
});

test('the contract still states the reply format and the size limit', () => {
    // Hardening must not have displaced the operational rules.
    assert.match(SRC, /RESPONSE FORMAT \(STRICT\)/);
    assert.match(SRC, /The fence is MANDATORY/);
    assert.match(SRC, /MAX_TOOL_CALL_CHARS/);
    assert.match(SRC, /never[\s\S]{0,40}?raw newlines inside a string value/);
});
