'use strict';
//
// The paid DeepSeek key must never leave for anything but the paid upstream.
//
// Measured defect: proxyTo() attached UPSTREAM_ANTHROPIC.token to EVERY proxied
// request, so picking the "omniroute" model sent the paid key to OmniRoute (and
// every other WEBCHAT_ROUTES gateway) on each call. The owner rule is absolute:
// the paid key is never routed to OmniRoute.
//
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// A recorder standing in for both OmniRoute and the paid upstream.
const seen = [];
const recorder = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', type: 'message', content: [], choices: [] }));
    });
});

const DUMMY_PAID_KEY = 'sk-test-not-a-real-key-0000';
let app;
let gw;
let base;

test.before(async () => {
    await new Promise((r) => recorder.listen(0, '127.0.0.1', r));
    const rec = `http://127.0.0.1:${recorder.address().port}`;
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-key-'));
    process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
    fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
    process.env.UPSTREAM_ANTHROPIC_AUTH_TOKEN = DUMMY_PAID_KEY;
    process.env.UPSTREAM_ANTHROPIC_BASE_URL = rec + '/paid-anthropic';
    process.env.UPSTREAM_OPENAI_BASE_URL = rec + '/paid-openai';
    process.env.WEBCHAT_ROUTES = `omniroute=${rec}/omni,'gemini webchat'=${rec}/gem`;
    delete process.env.API_TOKEN;
    app = require(path.join(__dirname, '..', 'server.js')).__test.app;
    await new Promise((r) => { gw = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${gw.address().port}`;
});
test.after(() => { gw.close(); recorder.close(); });

const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const carriesKey = (h) => JSON.stringify([h['x-api-key'], h.authorization]).includes(DUMMY_PAID_KEY);

test('the omniroute route never receives the paid key', async () => {
    seen.length = 0;
    await post('/v1/messages', { model: 'omniroute', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    const hit = seen.find((s) => s.url.startsWith('/omni'));
    assert.ok(hit, 'the request must reach the route');
    assert.strictEqual(carriesKey(hit.headers), false, 'paid key leaked to OmniRoute');
    assert.strictEqual(JSON.parse(hit.body).model, 'auto/best-coding');
});

test('no other webchat route receives the paid key either', async () => {
    seen.length = 0;
    await post('/v1/messages', { model: 'gemini webchat', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    const hit = seen.find((s) => s.url.startsWith('/gem'));
    assert.ok(hit);
    assert.strictEqual(carriesKey(hit.headers), false, 'paid key leaked to a webchat route');
});

test('the paid upstream itself still gets its key (flash)', async () => {
    seen.length = 0;
    await post('/v1/messages', { model: 'deepseek-v4-flash', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    const hit = seen.find((s) => s.url.startsWith('/paid-anthropic'));
    assert.ok(hit, 'a non-webchat model proxies to the paid upstream');
    assert.strictEqual(hit.headers['x-api-key'], DUMMY_PAID_KEY);
});

// The paid upstream is flash-only: a pro (or any unlisted) model is refused
// before a single byte reaches it — on both API shapes.
for (const [route, shape] of [['/v1/messages', 'anthropic'], ['/v1/chat/completions', 'openai']]) {
    test(`a non-flash model is refused before the paid upstream (${shape})`, async () => {
        seen.length = 0;
        const r = await post(route, { model: 'deepseek-v4-pro', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(seen.length, 0, 'the paid upstream must not be contacted');
    });
}
