'use strict';
const test = require('node:test');
const assert = require('node:assert');
const j = require('../jev.js');

test('Jev fails open on an empty request (never throws)', async () => {
    const r = await j.decide('', {});
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason, 'carries a reason');
});

test('Jev LIVE: rejects an unusable reply and accepts a good one', async () => {
    const contract = 'reply ONLY JSON {"edits":[{"file":..,"old_string":..,"new_string":..}]}';
    const bad = await j.replyIsUsable('{"edits":[]}', contract);
    const empty = await j.replyIsUsable('', contract);
    const good = await j.replyIsUsable(
        '{"edits":[{"file":"a.py","old_string":"x","new_string":"y"}]}', contract);

    if (!bad.ok) { console.log('SKIP (no key/network):', bad.reason); return; }

    console.log('  unusable ->', JSON.stringify(bad));
    console.log('  empty    ->', JSON.stringify(empty));
    console.log('  good     ->', JSON.stringify(good));
    assert.strictEqual(bad.usable, false, 'an empty edits array is not usable');
    assert.strictEqual(empty.usable, false, 'an empty reply is not usable');
    assert.strictEqual(good.usable, true, 'a real edit is usable');
});

test('Jev LIVE: a choice answer is always one we declared', async () => {
    const r = await j.decide('Assign a small mechanical edit to one lane.',
        { lane: { type: 'choice', instructions: 'Which lane?',
                  criteria: { deepseek: 'fast chat', dahl: 'reasoning' } } });
    if (!r.ok) { console.log('SKIP (no key/network):', r.reason); return; }
    console.log('  choice ->', JSON.stringify(r.answers.lane));
    assert.ok(['deepseek', 'dahl'].includes(r.answers.lane.choice),
        `undeclared choice: ${r.answers.lane.choice}`);
});
