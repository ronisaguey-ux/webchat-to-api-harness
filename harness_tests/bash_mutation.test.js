'use strict';
// Whether a run_bash changed anything is judged by the disk, not by the command text.
// Measured before this fix, through the real loop, every one of these honest answers was
// refused as 502 unverified ("no command was run that changes anything"):
//   * `python3 -c "open(…,'w').write(…)"` then "Created gen.py";
//   * `touch READY` then "Created the READY marker";
//   * `echo x > a.py` and `cat > b.py <<'EOF'` then "Wrote the file" — MUTATING_BASH_RE
//     only matched `>` at the START of a command, so no mid-command redirect counted.
// The /dev/null case pins the other direction: a disk-based check must not count a
// redirect that wrote nothing under the roots.
process.env.BASH_ALLOWED = 'true';
process.env.SANDBOX_ALLOW_BASH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('./_gateway');

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
test.after(() => G.stop());

const body = (prompt) => ({ model: 'deepseek webchat', max_tokens: 50, messages: [{ role: 'user', content: prompt }] });
const W = (f) => path.join(G.WORK, f);

test('a write made by a program counts as a mutation', async () => {
    const r = await G.post('/v1/messages', body('generate gen.py'), [
        G.call('run_bash', { command: `python3 -c "open('${W('gen.py')}','w').write('x = 1\\n')"` }),
        G.call('submit_answer', { text: 'Created gen.py with the constant.' }),
    ]);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    assert.strictEqual(fs.readFileSync(W('gen.py'), 'utf8'), 'x = 1\n');
});

test('touch counts as a mutation', async () => {
    const r = await G.post('/v1/messages', body('add the marker file'), [
        G.call('run_bash', { command: `touch ${W('READY')}` }),
        G.call('submit_answer', { text: 'Created the READY marker.' }),
    ]);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
});

test('a redirect to /dev/null is not a write', async () => {
    const r = await G.post('/v1/messages', body('update config.py'), [
        G.call('run_bash', { command: `ls ${G.WORK} > /dev/null` }),
        G.call('submit_answer', { text: 'Updated config.py with the new timeout.' }),
    ]);
    assert.strictEqual(r.status, 502, r.text.slice(0, 300));
    assert.strictEqual(r.json.error.outcome, 'unverified');
});

test('echo > file and a heredoc still count', async () => {
    for (const command of [`echo x > ${W('a.py')}`, `cat > ${W('b.py')} <<'EOF'\ny = 2\nEOF`]) {
        const r = await G.post('/v1/messages', body('write it'), [
            G.call('run_bash', { command }),
            G.call('submit_answer', { text: 'Wrote the file.' }),
        ]);
        assert.strictEqual(r.status, 200, command + ' -> ' + r.text.slice(0, 300));
    }
});

test('snapshot diff: added, modified, unchanged, truncated', () => {
    const S = require('../src/runtime/fs_snapshot');
    const d = fs.mkdtempSync(path.join(G.TMP, 'snap-'));
    fs.writeFileSync(path.join(d, 'f'), '1');
    fs.mkdirSync(path.join(d, 'node_modules'));
    const a = S.snapshot([d]);
    assert.strictEqual(S.changed(a, S.snapshot([d])), false);
    fs.writeFileSync(path.join(d, 'node_modules', 'x'), '1');
    assert.strictEqual(S.changed(a, S.snapshot([d])), false, 'skipped dirs are not work');
    fs.writeFileSync(path.join(d, 'f'), '22');
    assert.strictEqual(S.changed(a, S.snapshot([d])), true);
    assert.strictEqual(S.changed(S.snapshot([d], { limit: 0 }), S.snapshot([d])), null);
});
