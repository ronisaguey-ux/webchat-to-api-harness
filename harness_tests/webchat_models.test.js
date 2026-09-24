'use strict';
//
// webchat-models.test.js — the model-id grammar is the ONLY way a harness can change
// a webchat's internal toggles, so it is contract code: an id that parses to the wrong
// toggle state silently sends with the wrong configuration, and nothing downstream
// would notice.
//
// Run: node --test harness_tests/webchat_models.test.js

const test = require('node:test');
const assert = require('node:assert');
const W = require('../src/models/webchat-models.js');

test('DeepSeek publishes exactly the four combinations the owner listed', () => {
    const ids = W.modelIdsFor('deepseek');
    const labels = ids.map((id) => W.parse(id).label.replace('DeepSeek — ', ''));
    assert.deepStrictEqual(labels, ['default', 'Search', 'DeepThink', 'Search + DeepThink']);
});

test('a toggle id round-trips to the state it names', () => {
    assert.deepStrictEqual(
        W.toggleStateFor('deepseek', W.parse('webchat/deepseek/search').toggles),
        { search: true, deepthink: true },   // deepthink defaults ON, so it stays on
    );
    assert.deepStrictEqual(
        W.toggleStateFor('deepseek', W.parse('webchat/deepseek').toggles),
        { search: false, deepthink: true },
    );
});

test('toggle order in the id does not matter', () => {
    const a = W.parse('webchat/deepseek/deepthink+search');
    const b = W.parse('webchat/deepseek/search+deepthink');
    assert.deepStrictEqual(a.toggles.map((t) => t.id).sort(), b.toggles.map((t) => t.id).sort());
    assert.deepStrictEqual(W.toggleStateFor('deepseek', a.toggles), W.toggleStateFor('deepseek', b.toggles));
});

test('an unknown toggle is REPORTED, never silently dropped', () => {
    const p = W.parse('webchat/deepseek/nonsense');
    assert.deepStrictEqual(p.unknown, ['nonsense']);
    assert.strictEqual(p.toggles.length, 0);
});

test('an unknown site is reported rather than crashing', () => {
    const p = W.parse('webchat/nosuchsite/x');
    assert.strictEqual(p.site, null);
    assert.strictEqual(p.unknownSite, 'nosuchsite');
});

test('a non-webchat model id is not ours', () => {
    assert.strictEqual(W.parse('gpt-4o'), null);
    assert.strictEqual(W.parse(''), null);
});

test('sites whose UI was never read publish no guessed toggles', () => {
    // notegpt and claude could not be probed (site-side send gate; Cloudflare), so
    // they must advertise the bare id and NOT invent chip names.
    assert.deepStrictEqual(W.modelIdsFor('notegpt'), ['webchat/notegpt']);
    assert.deepStrictEqual(W.modelIdsFor('claude'), ['webchat/claude']);
});

test('requiresNewChat is carried through from the toggle that sets it', () => {
    // ChatGPT's Think and Freebuff's effort are baked into a thread, so they must
    // trigger the summarise-and-reopen path; DeepSeek's chips must not.
    assert.strictEqual(W.parse('webchat/chatgpt/think').requiresNewChat, true);
    assert.strictEqual(W.parse('webchat/freebuff/effortlow').requiresNewChat, true);
    assert.strictEqual(W.parse('webchat/deepseek/search').requiresNewChat, false);
});

test('every published id parses back to itself (no id is advertised that we cannot read)', () => {
    for (const id of W.allModelIds()) {
        const p = W.parse(id);
        assert.ok(p, `advertised id does not parse: ${id}`);
        assert.strictEqual(p.unknownSite, undefined, `advertised id names a missing site: ${id}`);
        assert.deepStrictEqual(p.unknown, [], `advertised id names an unknown toggle: ${id}`);
    }
    assert.ok(W.allModelIds().length >= 15, 'the surface should be the full set of combinations');
});
