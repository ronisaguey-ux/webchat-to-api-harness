'use strict';
//
// THE PROMPT GUARD MUST MEASURE THE STRING THE COMPOSER RECEIVES.
//
// sendPrompt() had this order:
//
//     1107:  if (prompt.length > MAX_PROMPT_CHARS) throw ...
//     1160:  const fullPrompt = buildFullPrompt(prompt, toolDefinitions);
//     1164:  input = await typePrompt(fullPrompt);      <- what the composer gets
//
// So the cap was enforced on the CALLER's message while `fullPrompt` — the string
// actually typed into the webchat composer — was never measured. buildFullPrompt
// prepends the whole tool-contract section and appends the REMINDER, so it is
// strictly longer than its input whenever tools are advertised.
//
// Measured here with the shipped 17-tool definition set: buildFullPrompt adds
// ~6,800 chars. A caller prompt of exactly MAX_PROMPT_CHARS (28,000) — which the
// guard accepts — becomes a 34,803-char composer insert, i.e. ABOVE the measured
// composer ceiling of 30,717. The composer truncates, and the refusal only arrives
// three insertVerified attempts later, after ~104K chars of CDP Input.insertText
// and three full composer clears, with an error that names the wrong number.
//
// These tests call the SHIPPED sendPrompt. The prompt is refused BEFORE any browser
// work, so the test needs no browser and cannot accidentally launch one: CDP_WS_URL
// points at a dead port, and _initBrowserInner returns from the attach branch
// (browser.js:341-371) without ever reaching puppeteer.launch.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-promptcap-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
// Dead CDP endpoint: the attach branch fails in milliseconds and NEVER launches Chrome.
process.env.CDP_WS_URL = 'ws://127.0.0.1:1/devtools/browser/00000000000000000000000000000000';

const REPO = path.join(__dirname, '..');
const browserSrc = fs.readFileSync(path.join(REPO, 'src', 'browser', 'browser.js'), 'utf-8');
const m = /MAX_PROMPT_CHARS = parseInt\(process\.env\.MAX_PROMPT_CHARS \|\| '(\d+)'/.exec(browserSrc);
assert.ok(m, 'MAX_PROMPT_CHARS must be declared in src/browser/browser.js');
const MAX_PROMPT_CHARS = Number(m[1]);

// The composer's own ceiling, MEASURED on the live Gemini lane.
const MEASURED_COMPOSER_LIMIT = 30717;

const { sendPrompt, buildFullPrompt } = require(path.join(REPO, 'src', 'browser', 'browser.js'));
const { getToolDefinitions } = require(path.join(REPO, 'src', 'tools', 'tools.js'));
const defs = getToolDefinitions();

test('the tool-contract section makes the typed prompt longer than the guarded one', () => {
    const one = buildFullPrompt('x', defs);
    const overhead = one.length - 1;
    assert.ok(overhead > 0,
        'buildFullPrompt must add the tool contract — if this ever returns the input '
        + 'unchanged, the two lengths coincide and the guard below is vacuous');
    const typed = buildFullPrompt('a'.repeat(MAX_PROMPT_CHARS), defs).length;
    assert.strictEqual(typed, MAX_PROMPT_CHARS + overhead);
    assert.ok(typed > MEASURED_COMPOSER_LIMIT,
        `a caller prompt AT the ${MAX_PROMPT_CHARS}-char cap composes to ${typed} chars, `
        + `which is ${typed - MEASURED_COMPOSER_LIMIT} over the measured composer ceiling `
        + `(${MEASURED_COMPOSER_LIMIT}) — the composer truncates and the model answers a cut prompt`);
});

test('a caller prompt AT the cap is refused by name, before any browser work', async () => {
    const prompt = 'a'.repeat(MAX_PROMPT_CHARS);
    await assert.rejects(
        sendPrompt(prompt, defs),
        (e) => {
            // The refusal must be the loud one. If it is not, the guard did not fire
            // and the send walked on into the browser (and, in production, into a
            // composer that silently truncates).
            assert.match(String(e.message), /prompt too large|composer accepts/i,
                `expected the oversized-prompt refusal, got: ${String(e.message).slice(0, 160)}`);
            // It must also name the number that actually gets typed, or the operator
            // shrinks the wrong thing.
            assert.match(String(e.message), new RegExp(String(buildFullPrompt(prompt, defs).length)),
                'the refusal must name the length of the string the composer receives');
            return true;
        }
    );
});

test('an in-budget caller prompt is NOT refused by the size guard', async () => {
    // Guards against over-correcting into a cap that rejects legitimate work. This one
    // is EXPECTED to fail downstream (no browser is reachable) — what matters is that
    // it fails for a browser reason, not the size guard.
    const prompt = 'a'.repeat(1000);
    const composed = buildFullPrompt(prompt, defs).length;
    assert.ok(composed < MAX_PROMPT_CHARS,
        `a 1,000-char prompt composes to ${composed} chars, inside the ${MAX_PROMPT_CHARS} cap`);
    await assert.rejects(
        sendPrompt(prompt, defs),
        (e) => {
            assert.doesNotMatch(String(e.message), /prompt too large|composer accepts/i,
                `a ${composed}-char prompt must pass the size guard, got: ${String(e.message).slice(0, 160)}`);
            return true;
        }
    );
});