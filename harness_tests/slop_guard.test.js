'use strict';
//
// Placeholder code a turn writes must not pass as finished work.
//
// Before this fix nothing inspected what write_file/edit_file wrote: a model could
// write `def compute_sharpe(r):\n    pass  # TODO: implement`, submit
// "Implemented compute_sharpe", and the gateway returned 200 (a real write had
// happened, so the phantom guard was satisfied).
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const G = require('./_gateway');
const { slopScan } = require('../src/tools/slop');

test.after(() => G.stop());
const body = (p) => ({ model: 'deepseek webchat', max_tokens: 50, messages: [{ role: 'user', content: p }] });

test('a stub written and submitted as done -> unverified_slop error', async () => {
    const f = path.join(G.WORK, 'metrics.py');
    const r = await G.post('/v1/messages', body('implement compute_sharpe'), [
        G.call('write_file', { path: f, content: 'def compute_sharpe(r):\n    pass  # TODO: implement\n' }),
        G.call('submit_answer', { text: 'Implemented compute_sharpe in metrics.py.' }),
    ]);
    assert.strictEqual(r.status, 502, r.text.slice(0, 300));
    assert.strictEqual(r.json.error.outcome, 'unverified_slop');
    assert.match(r.json.error.message, /metrics\.py: line 2/);
});

test('a stub replaced by a real implementation later in the turn -> 200', async () => {
    const f = path.join(G.WORK, 'metrics2.py');
    const r = await G.post('/v1/messages', body('implement compute_sharpe'), [
        G.call('write_file', { path: f, content: 'def compute_sharpe(r):\n    pass  # TODO: implement\n' }),
        G.call('edit_file', { path: f, old_string: '    pass  # TODO: implement', new_string: '    return sum(r) / len(r)' }),
        G.call('submit_answer', { text: 'Implemented compute_sharpe in metrics2.py.' }),
    ]);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
});

test('a TODO that was already in the file before the turn is not the model\'s slop', async () => {
    const f = path.join(G.WORK, 'legacy.py');
    fs.writeFileSync(f, '# TODO: old note\nx = 1\n');
    const r = await G.post('/v1/messages', body('set x to 2'), [
        G.call('edit_file', { path: f, old_string: 'x = 1', new_string: 'x = 2' }),
        G.call('submit_answer', { text: 'Updated x in legacy.py.' }),
    ]);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
});

test('the scanner: stubs flagged, legitimate code not', () => {
    const flagged = (after, file = 'a.py', before = '') => slopScan(before, after, file).length > 0;
    assert.ok(flagged('def f():\n    pass\n'));
    assert.ok(flagged('def f():\n    raise NotImplementedError\n'));
    assert.ok(flagged('function f() {\n  // ... rest of implementation\n}\n', 'a.js'));
    assert.ok(flagged('fn f() { todo!() }\n', 'a.rs'));
    assert.ok(!flagged('try:\n    x()\nexcept E:\n    pass\n'));
    assert.ok(!flagged('class A(ABC):\n    @abstractmethod\n    def f(self):\n        raise NotImplementedError\n'));
    assert.ok(!flagged('<input placeholder="Name" />\n', 'a.jsx'));
    assert.ok(!flagged('TODO: write docs\n', 'PLAN.md'));
    assert.ok(!flagged('# TODO keep\nx = 2\n', 'a.py', '# TODO keep\nx = 1\n'));
});
