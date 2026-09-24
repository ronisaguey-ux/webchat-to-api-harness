'use strict';
//
// edit_file exists because a full rewrite was the ONLY way to make a small change — and
// models fail at that. Measured: the lane was asked to make three small edits to a
// 297-line file, produced no write at all, ran the build, and reported success. The cost
// of an edit must scale with the size of the CHANGE, not the size of the file.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { executeTool, getToolDefinitions } = require(path.join(__dirname, '..', 'tools.js'));

// The sandbox only permits /home/roni/Roni_workspace/{t2b,helpotron,webchat_worker/harness}
// and /tmp/opencode, so the system temp dir is DENIED — a test writing there fails with a
// sandbox error that reads like a tool bug.
const SAFE_TMP = '/tmp/opencode/editfile-tests';
const tmp = () => {
    fs.mkdirSync(SAFE_TMP, { recursive: true });
    return path.join(fs.mkdtempSync(path.join(SAFE_TMP, 'case-')), 'target.txt');
};
const write = (p, s) => fs.writeFileSync(p, s, 'utf-8');
const read = (p) => fs.readFileSync(p, 'utf-8');

test('edit_file is offered to the model and write_file still is', () => {
    const names = getToolDefinitions().map((d) => (d.function ? d.function.name : d.name));
    assert.ok(names.includes('edit_file'), 'a surgical edit tool must be available');
    assert.ok(names.includes('write_file'), 'full writes are still needed for new files');
});

test('replaces a unique string and leaves the rest of the file alone', async () => {
    const p = tmp();
    write(p, 'a\n  const x = 1;\nb\n');
    const r = await executeTool('edit_file', { path: p, old_string: '  const x = 1;', new_string: '  const x = 2;' }, {});
    assert.strictEqual(r.success, true);
    assert.strictEqual(read(p), 'a\n  const x = 2;\nb\n');
});

test('an ambiguous old_string changes NOTHING', async () => {
    const p = tmp();
    write(p, 'return 1;\nreturn 1;\n');
    const r = await executeTool('edit_file', { path: p, old_string: 'return 1;', new_string: 'return 2;' }, {});
    assert.strictEqual(r.success, false, 'a doubly-matching snippet must be refused, not guessed at');
    assert.match(r.error, /appears 2 times/);
    assert.strictEqual(read(p), 'return 1;\nreturn 1;\n', 'the file must be untouched');
});

test('a missing old_string fails with a hint and changes nothing', async () => {
    const p = tmp();
    write(p, 'hello\n');
    const r = await executeTool('edit_file', { path: p, old_string: 'goodbye', new_string: 'x' }, {});
    assert.strictEqual(r.success, false);
    assert.match(r.error, /was not found/);
    assert.strictEqual(read(p), 'hello\n');
});

test('a not-found error that only differs by indentation names that as the likely cause', async () => {
    const p = tmp();
    write(p, 'function f() {\n    return 1;\n}\n');
    // The model remembered the first line but not what followed. The snippet as a whole is
    // absent, yet one of its lines is present — so the error must name indentation or the
    // surrounding lines as the likely cause rather than leaving a blind retry.
    const r = await executeTool('edit_file', { path: p, old_string: 'return 1;\n    return 2;', new_string: 'return 9;' }, {});
    assert.strictEqual(r.success, false);
    assert.match(r.error, /indentation/, 'the hint must point at the real mistake');
});

test('replace_all changes every occurrence when asked', async () => {
    const p = tmp();
    write(p, 'x\ny\nx\n');
    const r = await executeTool('edit_file', { path: p, old_string: 'x', new_string: 'z', replace_all: true }, {});
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.replacements, 2);
    assert.strictEqual(read(p), 'z\ny\nz\n');
});

test('a replacement containing $ is written LITERALLY', async () => {
    // String.replace expands $&, $1, $` and $' in the replacement. JSX and template
    // literals are full of $, so a code edit would corrupt silently.
    const p = tmp();
    write(p, 'const c = 1;\n');
    const repl = 'const c = `${a} $& $1 $`;';
    const r = await executeTool('edit_file', { path: p, old_string: 'const c = 1;', new_string: repl }, {});
    assert.strictEqual(r.success, true);
    assert.strictEqual(read(p), repl + '\n', '$ must not be treated as a replace pattern');
});

test('an empty new_string deletes the matched text', async () => {
    const p = tmp();
    write(p, 'keep\ndelete me\nkeep\n');
    const r = await executeTool('edit_file', { path: p, old_string: 'delete me\n', new_string: '' }, {});
    assert.strictEqual(r.success, true);
    assert.strictEqual(read(p), 'keep\nkeep\n');
});

test('a newline-spanning edit keeps every other line byte-identical', async () => {
    const p = tmp();
    const before = ['line1', 'line2', 'line3', 'line4'].join('\n');
    write(p, before);
    const r = await executeTool('edit_file', { path: p, old_string: 'line2\nline3', new_string: 'LINE2' }, {});
    assert.strictEqual(r.success, true);
    assert.strictEqual(read(p), ['line1', 'LINE2', 'line4'].join('\n'));
});

test('an empty old_string is refused rather than matching everywhere', async () => {
    const p = tmp();
    write(p, 'abc\n');
    const r = await executeTool('edit_file', { path: p, old_string: '', new_string: 'x' }, {});
    assert.strictEqual(r.success, false);
    assert.strictEqual(read(p), 'abc\n');
});
