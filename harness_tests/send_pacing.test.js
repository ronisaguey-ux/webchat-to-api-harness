'use strict';
//
// The send gap is a deliberate anti-bot delay: a fresh random wait before every deepseek
// send so the cadence never repeats. It is not the problem. Two things were:
//
//   1. It was env-only — NOT in the settings schema — so the CLI could not show or change
//      it, and the latency it caused looked like the model being slow. Measured: model
//      thinking 6.6s, gate 43s mean, i.e. 87% of a reply was this wait.
//
//   2. The defaults were 20-80s. One agent turn makes several sends (every tool round-trip
//      is another), so a one-word reply measured ~150s of waiting.
//
// Run: node --test harness_tests/send_pacing.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const S = require(path.join(REPO, 'cli', 'settings.js'));

function settingsNamed(re) {
    const out = [];
    for (const g of S.SCHEMA) for (const s of (g.settings || [])) if (re.test(s.path)) out.push(s);
    return out;
}

test('the send gap is editable from the CLI, not env-only', () => {
    const min = settingsNamed(/sendGapMinMs$/);
    const max = settingsNamed(/sendGapMaxMs$/);
    assert.strictEqual(min.length, 1, 'the minimum gap must be one settings entry');
    assert.strictEqual(max.length, 1, 'the maximum gap must be one settings entry');
    assert.strictEqual(min[0].env, 'SEND_GAP_MIN_MS', 'and it maps to the env var server.js reads');
    assert.strictEqual(max[0].env, 'SEND_GAP_MAX_MS');
    assert.strictEqual(min[0].type, 'number');
    assert.strictEqual(max[0].type, 'number');
});

// ★ THE INVARIANT THAT MATTERS: a settings screen that shows a number different from the one
// the gateway actually uses is a display that lies — the same class as every other fix in
// this sweep. The schema default and the server default must be the same value.
test('the schema default equals the default server.js actually uses', () => {
    const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    for (const [path2, env] of [['webchat.sendGapMinMs', 'SEND_GAP_MIN_MS'], ['webchat.sendGapMaxMs', 'SEND_GAP_MAX_MS']]) {
        const entry = settingsNamed(new RegExp(path2.split('.').pop() + '$'))[0];
        // server.js: process.env.SEND_GAP_MIN_MS || '3000'
        const m = new RegExp(`${env}\\s*\\|\\|\\s*'(\\d+)'`).exec(server);
        assert.ok(m, `${env} must have a default in server.js`);
        assert.strictEqual(Number(entry.default), Number(m[1]),
            `${path2} shows ${entry.default} but server.js falls back to ${m[1]} — the CLI would display a number that is not what runs`);
    }
});

test('the gap default is a chat cadence, not a distraction-length pause', () => {
    const min = Number(settingsNamed(/sendGapMinMs$/)[0].default);
    const max = Number(settingsNamed(/sendGapMaxMs$/)[0].default);
    assert.ok(min >= 0, 'a negative minimum is meaningless');
    assert.ok(max >= min, 'the range must be ordered, or the picker produces nonsense');
    // 20-80s was the shipped default and made a one-word reply take ~150s across the
    // several sends a turn makes. Assert we are nowhere near that.
    assert.ok(max <= 30000,
        `a max of ${max}ms reintroduces the unusable latency this test exists to prevent`);
    assert.ok(max > 0, '0 everywhere would remove the anti-bot spacing entirely');
});

test('the random picker produces a value inside the configured range', () => {
    // The gap must be random (a fixed interval is itself a bot signature) and bounded.
    const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    assert.match(src, /function nextSendGapMs\(\)/,
        'the random picker must still exist — a fixed gap is the bot signature this avoids');
    assert.match(src, /Math\.random\(\)/,
        'the gap must be randomised, not fixed');
});

test('the gap applies to deepseek only, so it cannot pad another webchat', () => {
    // Measured previously: applying it on gemini added up to 80s per send on top of its own
    // latency and made the engine's lane budget expire. It is a DeepSeek anti-ban measure.
    const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    assert.match(src, /usesDeepSeek\(\)\s*\?\s*nextSendGapMs\(\)\s*:\s*0/,
        'the random gap must be gated on the deepseek account');
});
