'use strict';
// edit_file's result goes back to the tab, so its size is paid on every edit. Measured
// before this fix: a one-line edit to a 3,000-line file returned `oldContent` — the
// entire pre-edit file, ~100KB — in the result.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-edit-size-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
process.env.SANDBOX_ROOTS = TMP;
const tools = require('../src/tools/tools');
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('a one-line edit returns the changed hunk, not the whole file', async () => {
    const file = path.join(TMP, 'big.py');
    const lines = [];
    for (let i = 0; i < 3000; i++) lines.push(`value_${i} = ${i}  # padding padding padding`);
    fs.writeFileSync(file, lines.join('\n'));
    const r = await tools.executeTool('edit_file', { path: file, old_string: 'value_1500 = 1500', new_string: 'value_1500 = -1' });
    assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 300));
    const size = JSON.stringify(r).length;
    assert.ok(size < 2000, `result is ${size} chars`);
    assert.strictEqual(r.oldContent, undefined);
    assert.match(r.diff, /^-value_1500 = 1500/m);
    assert.match(r.diff, /^\+value_1500 = -1/m);
    assert.match(r.diff, /^ value_1497 = 1497/m, 'three lines of context before');
    assert.match(r.diff, /^ value_1503 = 1503/m, 'three lines of context after');
    assert.match(fs.readFileSync(file, 'utf8'), /value_1500 = -1  #/);
});

test('the hunk is capped for a wide replace_all', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `x${i}`).join('\n');
    const after = before.replace(/^x(\d+)$/gm, 'y$1');
    const h = tools.changedHunk(before, after);
    assert.ok(h.split('\n').length <= 122, 'capped');
    assert.match(h, /more diff lines/);
});
