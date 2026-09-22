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

// ── the wired interceptor: shadow mode must LOG, not change behaviour ────────
test('shadow mode never changes the reply, and off mode never calls Jev', async () => {
    const path = require.resolve('../server.js');
    const browserPath = require.resolve('../browser');
    const calls = { openNewChat: 0 };
    const stub = new Proxy({}, { get(_t, k) {
        if (k === 'openNewChat') return async () => { calls.openNewChat += 1; };
        if (k === 'sendPrompt') return async () => '{"edits":[]}';   // a reply Jev calls UNUSABLE
        if (k === 'getToolDefinitions') return () => [];
        return async () => {};
    }});
    require.cache[browserPath] = { id: browserPath, filename: browserPath, loaded: true, exports: stub, children: [], paths: [] };

    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };

    try {
        process.env.JEV_INTERCEPT = 'off';
        delete require.cache[path];
        let S = require('../server.js');
        const rOff = await S.countedSend('contract: {"edits":[{"file":..}]}', []);
        assert.strictEqual(rOff, '{"edits":[]}', 'off: the reply is returned untouched');
        assert.strictEqual(logs.filter(l => l.includes('[jev:')).length, 0, 'off: Jev is never consulted');

        logs.length = 0;
        process.env.JEV_INTERCEPT = 'shadow';
        delete require.cache[path];
        S = require('../server.js');
        const rShadow = await S.countedSend('contract: {"edits":[{"file":..}]}', []);
        assert.strictEqual(rShadow, '{"edits":[]}', 'shadow: the reply is STILL returned untouched');
        const hit = logs.filter(l => l.includes('UNUSABLE'));
        console.log = orig;
        console.log('  shadow log ->', hit[0] || '(none)');
        assert.strictEqual(hit.length, 1, 'shadow: it logged exactly one UNUSABLE verdict');
    } finally {
        console.log = orig;
        process.env.JEV_INTERCEPT = 'off';
    }
});
