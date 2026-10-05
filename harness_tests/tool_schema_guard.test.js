'use strict';
//
// A tool call that does not satisfy its own schema must be refused before it runs.
//
// Reproduced before this fix: edit_file({path, old_string}) with new_string
// omitted ran content.replace(old, () => undefined), wrote the literal text
// "undefined" into the file, and returned success:true.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-schema-'));
process.env.SANDBOX_ROOTS = WORK;
const TMPCFG = path.join(WORK, 'harness.config.json');
fs.writeFileSync(TMPCFG, '{}');
process.env.HARNESS_CONFIG = TMPCFG;
const T = require(path.join(__dirname, '..', 'src', 'tools', 'tools.js'));

test('edit_file without new_string is refused and the file is untouched', async () => {
    const f = path.join(WORK, 'a.py');
    fs.writeFileSync(f, 'a = 1\nb = 2\n');
    const r = await T.executeTool('edit_file', { path: f, old_string: 'a = 1' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /new_string/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'a = 1\nb = 2\n');
});

test('write_file with non-string content is refused, never "[object Object]"', async () => {
    const f = path.join(WORK, 'b.py');
    const r = await T.executeTool('write_file', { path: f, content: { code: 'x = 1' } });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /content/);
    assert.ok(!fs.existsSync(f));
});

test('every tool refuses a call missing any one of its required arguments', async () => {
    let checked = 0;
    for (const def of T.TOOL_DEFINITIONS) {
        // An unavailable tool (bash gate off, no search key) is refused earlier, for that reason.
        if (typeof def.available === 'function' && !def.available()) continue;
        const req = (def.parameters && def.parameters.required) || [];
        for (const missing of req) {
            const args = {};
            for (const name of req) if (name !== missing) args[name] = def.parameters.properties[name]?.type === 'boolean' ? true : 'x';
            const r = await T.executeTool(def.name, args);
            assert.strictEqual(r.success, false, `${def.name} without ${missing}`);
            // Refused BECAUSE of the schema, not by some later accident of the handler.
            assert.match(String(r.error), new RegExp(`missing required argument "${missing}"`), `${def.name} without ${missing}: ${r.error}`);
            checked++;
        }
    }
    assert.ok(checked >= 10, `only ${checked} (tool, argument) pairs were checked`);
});

test('a boolean spelled "false" means false, not a truthy string', async () => {
    // Before: args.replace_all === "false" is truthy, so an ambiguous edit that the
    // model explicitly asked NOT to apply everywhere rewrote every occurrence.
    const f = path.join(WORK, 'c.txt');
    fs.writeFileSync(f, 'hello\nhello\n');
    const r = await T.executeTool('edit_file', { path: f, old_string: 'hello', new_string: 'hi', replace_all: 'false' });
    assert.strictEqual(r.success, false, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hello\nhello\n');
    const r2 = await T.executeTool('edit_file', { path: f, old_string: 'hello', new_string: 'hi', replace_all: 'true' });
    assert.strictEqual(r2.success, true);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hi\nhi\n');
});
