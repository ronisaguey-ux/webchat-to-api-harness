'use strict';
//
// Owner rule (09-24): a malformed tool-JSON reply must NEVER fail silently. It must come
// back to the agent as a concrete "malformed JSON detected" error naming what was wrong,
// and a model stuck in a shape it cannot produce must stop rather than burn the budget —
// then retry itself on a timer, a bounded number of times.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { __test } = require(path.join(__dirname, '..', 'server.js'));
const { describeMalformedJson, malformedCorrectionMsg } = __test;

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

test('the reason names a raw line break, not a generic "malformed"', () => {
    const r = describeMalformedJson('{"tool":"write_file","content":"a' + NL + 'b"}');
    assert.match(r, /raw line break/, 'the model must be told WHICH thing is wrong');
    assert.match(r, /\\n/, 'and shown the escape it should have used');
});

test('the reason distinguishes the failure modes the model actually produces', () => {
    const cases = [
        ['{"tool":"write_file","content":"""a"""}', /triple quotes/],
        ['{"tool":"write_file","params":{"path":"/p"', /missing closing brace/],
        ['{"tool":"write_file","content":"abc', /never closed/],
        ['{"tool":"write_file","content":"a' + TAB + 'b"}', /raw tab/],
        ['{"foo":1}', /no "tool" field/],
        ['', /empty/],
    ];
    for (const [text, expected] of cases) {
        assert.match(describeMalformedJson(text), expected, `wrong reason for: ${text.slice(0, 40)}`);
    }
});

test('the reason is never the bare word "malformed"', () => {
    // The whole point: a model that cannot tell what broke resends the same broken shape.
    const samples = [
        '{"tool":"x","content":"a' + NL + 'b"}',
        '{"tool":"x","content":"""a"""}',
        '{"tool":"x"',
        '{"tool":"x","content":"a',
        'not json at all',
    ];
    for (const s of samples) {
        const r = describeMalformedJson(s);
        assert.ok(r && r.length > 15, `reason too vague for ${JSON.stringify(s.slice(0, 30))}: "${r}"`);
        assert.ok(!/^malformed/i.test(r), 'must name the defect, not restate the category');
    }
});

test('the correction message carries the reason, the streak and the limit', () => {
    const msg = malformedCorrectionMsg('a raw line break inside a string value', 3, 5);
    assert.match(msg, /MALFORMED JSON DETECTED/, 'the heading the owner asked for');
    assert.match(msg, /raw line break/, 'the specific reason');
    assert.match(msg, /attempt 3 of 5/, 'where it is in the streak');
    assert.match(msg, /STOPS/, 'and that stopping is what happens next');
});

test('the correction tells the model to prefer edit_file for multi-line content', () => {
    // Rewriting a whole file as one JSON string is the single most common source of a raw
    // newline, so the correction must point at the tool that avoids it entirely.
    const msg = malformedCorrectionMsg('a raw line break inside a string value', 1, 5);
    assert.match(msg, /edit_file/);
});

test('the correction quotes a fenced envelope the model can copy', () => {
    // The example is a deliberately generic PLACEHOLDER (tool/name/params), so it is not
    // itself parseable — what matters is that it shows the required shape: a json fence
    // containing a single "tool" object. Without the fence the chat renders the backticks
    // as formatting and corrupts the JSON, which is why the fence is mandatory.
    const msg = malformedCorrectionMsg('a raw line break inside a string value', 2, 5);
    const parts = msg.split('```json');
    assert.strictEqual(parts.length, 2, 'exactly one fenced example');
    const fenced = parts[1].split('```')[0];
    assert.match(fenced, /"tool"/, 'the example must show the tool envelope');
    assert.match(msg.slice(0, msg.indexOf('```json')), /escape/i, 'the rules must precede the example');
});

test('the defaults are the owner-specified ones: 5 / enabled / 100s / 5', () => {
    const config = require(path.join(__dirname, '..', 'src', 'core', 'config.js'));
    assert.strictEqual(config.maxMalformedRounds, 5);
    assert.strictEqual(config.malformedRetryEnabled, true);
    assert.strictEqual(config.malformedRetryDelaySec, 100);
    assert.strictEqual(config.malformedMaxRetries, 5);
});

test('the delay is read in SECONDS and the settings are CLI-reachable', () => {
    // Configured in seconds because that is how a human thinks about a backoff; the code
    // multiplies at the sleep. A unit mix-up here would be a 100ms wait, not 100s.
    const config = require(path.join(__dirname, '..', 'src', 'core', 'config.js'));
    assert.ok(config.malformedRetryDelaySec >= 1 && config.malformedRetryDelaySec < 3600,
        'sane seconds range — a ms value here would be a bug');
    const fs = require('fs');
    const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'cli', 'settings.js'), 'utf8');
    for (const p of ['limits.maxMalformedRounds', 'limits.malformedRetryEnabled', 'limits.malformedRetryDelaySec', 'limits.malformedMaxRetries']) {
        assert.ok(settingsSrc.includes(p), `${p} must be tunable from the CLI`);
    }
});

test('the shipped policy: correct below the threshold, retry above it, stop when spent', () => {
    const { malformedAction } = __test;
    const cfg = { maxMalformedRounds: 5, malformedRetryEnabled: true, malformedRetryDelaySec: 100, malformedMaxRetries: 5 };
    const R = 'a raw line break inside a string value';

    // Below the threshold: a plain correction, no pause.
    assert.strictEqual(malformedAction({ malformedRounds: 1, malformedRetries: 0 }, cfg, R).action, 'correct');
    assert.strictEqual(malformedAction({ malformedRounds: 4, malformedRetries: 0 }, cfg, R).action, 'correct');

    // At the threshold with retries left: pause, and the wait is the configured SECONDS in ms.
    const retry = malformedAction({ malformedRounds: 5, malformedRetries: 0 }, cfg, R);
    assert.strictEqual(retry.action, 'retry');
    assert.strictEqual(retry.waitMs, 100000, '100 seconds must become 100000 ms');

    // Retries spent: stop, and the reason for stopping is stated.
    const stop = malformedAction({ malformedRounds: 5, malformedRetries: 5 }, cfg, R);
    assert.strictEqual(stop.action, 'stop');
    assert.match(stop.why, /5 automatic retries/);
});

test('the delay is configurable in seconds and converted once', () => {
    const { malformedAction } = __test;
    for (const sec of [30, 60, 100, 300]) {
        const v = malformedAction({ malformedRounds: 9, malformedRetries: 0 },
            { maxMalformedRounds: 5, malformedRetryEnabled: true, malformedRetryDelaySec: sec, malformedMaxRetries: 5 }, 'x');
        assert.strictEqual(v.waitMs, sec * 1000, `${sec}s must be ${sec * 1000}ms`);
    }
});

test('auto-retry can be switched off, and says so when it stops', () => {
    const { malformedAction } = __test;
    const v = malformedAction({ malformedRounds: 5, malformedRetries: 0 },
        { maxMalformedRounds: 5, malformedRetryEnabled: false, malformedRetryDelaySec: 100, malformedMaxRetries: 5 }, 'x');
    assert.strictEqual(v.action, 'stop', 'disabled means it does not wait and retry');
    assert.match(v.why, /disabled/);
});

test('zero retries stops immediately without touching the enable switch', () => {
    const { malformedAction } = __test;
    const v = malformedAction({ malformedRounds: 5, malformedRetries: 0 },
        { maxMalformedRounds: 5, malformedRetryEnabled: true, malformedRetryDelaySec: 100, malformedMaxRetries: 0 }, 'x');
    assert.strictEqual(v.action, 'stop');
});

test('the threshold itself is configurable', () => {
    const { malformedAction } = __test;
    const cfg = { malformedRetryEnabled: true, malformedRetryDelaySec: 10, malformedMaxRetries: 3 };
    assert.strictEqual(malformedAction({ malformedRounds: 2, malformedRetries: 0 }, Object.assign({ maxMalformedRounds: 3 }, cfg), 'x').action, 'correct');
    assert.strictEqual(malformedAction({ malformedRounds: 3, malformedRetries: 0 }, Object.assign({ maxMalformedRounds: 3 }, cfg), 'x').action, 'retry');
    assert.strictEqual(malformedAction({ malformedRounds: 2, malformedRetries: 0 }, Object.assign({ maxMalformedRounds: 2 }, cfg), 'x').action, 'retry');
});
