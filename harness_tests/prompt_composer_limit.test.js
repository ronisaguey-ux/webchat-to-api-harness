'use strict';
//
// Measured on the live Gemini lane: a 150,682-char prompt went in, the composer kept
// 30,717, and the send PROCEEDED "unverified" — so the model worked from a prompt with
// the middle missing and no way to know. A truncated prompt is worse than a refused one.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-cap2-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');

const REPO = path.join(__dirname, '..');
const browserSrc = fs.readFileSync(path.join(REPO, 'src', 'browser', 'browser.js'), 'utf-8');

function cfg() {
    for (const k of Object.keys(require.cache)) {
        if (/(config|master_config)\.js$/.test(k)) delete require.cache[k];
    }
    return require(path.join(REPO, 'src', 'core', 'config.js'));
}

// The composer's own ceiling, MEASURED on the live lane. Everything else must fit below it.
const MEASURED_COMPOSER_LIMIT = 30717;

test('the prompt cap is below what the composer actually accepts', () => {
    const c = cfg();
    const m = /MAX_PROMPT_CHARS = parseInt\(process\.env\.MAX_PROMPT_CHARS \|\| '(\d+)'/.exec(browserSrc);
    assert.ok(m, 'MAX_PROMPT_CHARS must be declared');
    const maxPrompt = Number(m[1]);
    assert.ok(maxPrompt < MEASURED_COMPOSER_LIMIT,
        `MAX_PROMPT_CHARS (${maxPrompt}) must be under the measured composer limit (${MEASURED_COMPOSER_LIMIT}) — `
        + `above it, the site truncates silently`);
    assert.strictEqual(c.modelToolResultCap + maxPrompt, maxPrompt + c.modelToolResultCap, 'sanity');
});

test('one tool result cannot fill the whole prompt on its own', () => {
    const c = cfg();
    const m = /MAX_PROMPT_CHARS = parseInt\(process\.env\.MAX_PROMPT_CHARS \|\| '(\d+)'/.exec(browserSrc);
    const maxPrompt = Number(m[1]);
    assert.ok(c.modelToolResultCap < maxPrompt * 0.7,
        `the tool-result cap (${c.modelToolResultCap}) must leave room for the system prompt and the `
        + `follow-up instructions inside a ${maxPrompt}-char prompt, or the next result re-overflows it`);
});

test('a truncated composer is refused, not sent', () => {
    // The exact branch that let the measured overflow through.
    assert.match(browserSrc, /prompt exceeds what this composer accepts/,
        'sending a prompt the composer truncated must throw');
    assert.match(browserSrc, /lastLen < text\.length \* 0\.9/,
        'the refusal must key on a SUBSTANTIALLY shorter composer, not any difference');
});
