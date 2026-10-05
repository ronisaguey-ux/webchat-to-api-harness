'use strict';
// Drive the REAL gateway over HTTP with scripted webchat replies.
//
// Every reply the "webchat" gives is taken from TEST_FAKE_RESPONSES (one per
// send, the last repeating), so a test walks the true path — express route,
// handleRequest, the tool loop, the tools, the response shape — and asserts on
// what a caller actually receives. Nothing here opens a browser.
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-gw-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
// A non-deepseek, non-gemini URL: no anti-bot send spacing, no cross-process lock.
process.env.WEBCHAT_URL = 'http://127.0.0.1:9/fake-webchat';
process.env.TEST_FAKE_RESPONSE = process.env.TEST_FAKE_RESPONSE || 'unused';
process.env.SANDBOX_ROOTS = WORK;
process.env.JEV_INTERCEPT = 'off';
process.env.NARRATION = 'false';
process.env.ANTI_SPIRAL = process.env.ANTI_SPIRAL || 'false';
process.env.MAX_TOOL_ROUNDS = process.env.MAX_TOOL_ROUNDS || '8';
process.env.NEW_CHAT_EVERY_SENDS = process.env.NEW_CHAT_EVERY_SENDS || '0';
process.env.SEND_SPACING_FILE = path.join(TMP, 'last_send');
delete process.env.API_TOKEN;
delete process.env.UPSTREAM_ANTHROPIC_AUTH_TOKEN;

const server = require(path.join(__dirname, '..', 'server.js'));
const { app } = server.__test;

let base = null;
let listener = null;
async function start() {
    if (base) return base;
    await new Promise((resolve) => {
        listener = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${listener.address().port}`;
    return base;
}
function stop() {
    if (listener) listener.close();
    listener = null;
    base = null;
}

const fence = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';
const call = (tool, params) => fence({ tool, params });

async function post(route, body, replies) {
    await start();
    process.env.TEST_FAKE_RESPONSES = JSON.stringify(replies);
    const res = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or plain */ }
    return { status: res.status, headers: res.headers, text, json };
}


module.exports = { TMP, WORK, server, start, stop, post, call, fence };
