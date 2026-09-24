'use strict';
//
// The hub is the ONE url a user points an agent at; it forwards each request to the
// per-webchat gateway that owns that model. These tests pin the two things that make
// it safe: a model id always lands on the right webchat, and an unknown one is
// refused instead of silently answered by whichever gateway came first -- which is
// exactly how a gemini request used to come back answered by the DeepSeek browser.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createHub, targetFor } = require('../cli/hub.js');
const models = require('../src/models/webchat-models.js');

const GATES = [
    { site: 'deepseek', gatewayPort: 18181 },
    { site: 'gemini', gatewayPort: 18182 },
];

test('a model id routes to the gateway that owns its webchat', () => {
    assert.strictEqual(targetFor('webchat/deepseek', GATES, models).url, 'http://127.0.0.1:18181');
    assert.strictEqual(targetFor('webchat/gemini', GATES, models).url, 'http://127.0.0.1:18182');
});

test('every toggle combination routes to the same webchat', () => {
    for (const id of ['webchat/deepseek/search', 'webchat/deepseek/deepthink', 'webchat/deepseek/deepthink+search']) {
        const t = targetFor(id, GATES, models);
        assert.strictEqual(t.site, 'deepseek', `${id} resolved to ${t.site}`);
        assert.strictEqual(t.url, 'http://127.0.0.1:18181');
    }
});

test('a webchat that is not connected is refused, never guessed at', () => {
    const t = targetFor('webchat/chatgpt', GATES, models);
    assert.ok(t.error, 'an unconnected webchat must not resolve');
    assert.match(t.error, /chatgpt/);
});

test('an explicit base url is honoured', () => {
    assert.strictEqual(targetFor('http://127.0.0.1:9999', GATES, models).url, 'http://127.0.0.1:9999');
});

test('an empty model is refused', () => {
    assert.ok(targetFor('', GATES, models).error);
});

async function withHub(fn) {
    const hub = createHub({ readGates: () => GATES, models, log: () => {} });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));
    const port = hub.address().port;
    try { await fn(port); } finally { hub.close(); }
}

test('an unknown model is a 404 that names the webchat', async () => {
    await withHub(async (port) => {
        const res = await post(port, '/v1/chat/completions', { model: 'webchat/chatgpt' });
        assert.strictEqual(res.code, 404);
        assert.match(res.body.error.message, /chatgpt/);
    });
});

test('the request is relayed verbatim to the owning gateway', async () => {
    // Stand up a fake sub-gateway and prove the hub forwards to IT and not the other.
    const seen = [];
    const upstream = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            seen.push({ url: req.url, body: JSON.parse(raw) });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'from-gemini' } }] }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const up = upstream.address().port;

    const hub = createHub({
        readGates: () => [{ site: 'gemini', gatewayPort: up }],
        models,
        log: () => {},
    });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));

    try {
        const res = await post(hub.address().port, '/v1/chat/completions', {
            model: 'webchat/gemini',
            messages: [{ role: 'user', content: 'hi' }],
        });
        assert.strictEqual(res.code, 200);
        assert.strictEqual(res.body.choices[0].message.content, 'from-gemini');
        assert.strictEqual(seen.length, 1, 'the upstream was not called exactly once');
        // The body must arrive untouched: a hub that rewrites messages is a second
        // implementation of the protocol, and the second one is the buggy one.
        assert.deepStrictEqual(seen[0].body.messages, [{ role: 'user', content: 'hi' }]);
        assert.strictEqual(seen[0].url, '/v1/chat/completions');
    } finally {
        hub.close();
        upstream.close();
    }
});

test('/v1/models lists the union of the connected webchats', async () => {
    const mk = (ids) => http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    });
    const a = mk(['webchat/deepseek', 'webchat/deepseek/search']);
    const b = mk(['webchat/gemini']);
    await new Promise((r) => a.listen(0, '127.0.0.1', r));
    await new Promise((r) => b.listen(0, '127.0.0.1', r));

    const hub = createHub({
        readGates: () => [
            { site: 'deepseek', gatewayPort: a.address().port },
            { site: 'gemini', gatewayPort: b.address().port },
        ],
        models,
        log: () => {},
    });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));

    try {
        const res = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${hub.address().port}/v1/models`, (r) => {
                let raw = '';
                r.on('data', (c) => { raw += c; });
                r.on('end', () => resolve(JSON.parse(raw)));
            }).on('error', reject);
        });
        const ids = res.data.map((m) => m.id);
        assert.deepStrictEqual(ids, ['webchat/deepseek', 'webchat/deepseek/search', 'webchat/gemini']);
    } finally {
        hub.close();
        a.close();
        b.close();
    }
});

function post(port, path, body) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        const req = http.request({
            hostname: '127.0.0.1', port, path, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch { /* non-JSON is a failure the caller asserts on */ }
                resolve({ code: res.statusCode, body: parsed, raw });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}
