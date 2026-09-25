'use strict';
//
// hub.js — ONE url in front of every selected webchat.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Each webchat is driven by its own browser, so each needs its own gateway: a request
// has to reach the tab that owns that site, and one process cannot hold two CDP
// endpoints without pretending a DeepSeek answer came from Gemini. Those per-site
// gateways are the SUB urls — :8181/v1 is DeepSeek, :8182/v1 is Gemini.
//
// That leaves the user with one url PER webchat, which is the thing they should not
// have to think about. So the hub sits on a single port and forwards by model id:
//
//     http://127.0.0.1:<hub>/v1     <- point the agent HERE
//         webchat/deepseek                    -> :8181
//         webchat/deepseek/deepthink+search   -> :8181
//         webchat/gemini                      -> :8182
//
// /v1/models lists the union, so the harness sees every webchat AND every toggle
// combination as one flat model list and does not need to know a hub exists.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
// It does not parse or rewrite the conversation. It is a router: it looks at the
// model id, picks a target, and relays the request and the reply byte for byte.
// Anything else would mean two places that understand the harness protocol, and the
// second one would be the buggy one.

const http = require('http');

// A model id resolves to a site through the registry, so the mapping is derived from
// the same table the gateways publish rather than a second list that can drift.
function targetFor(modelId, gates, models) {
    const id = String(modelId || '').trim();
    if (!id) return { error: 'no model given' };
    // A fully explicit base url wins: it lets a caller pin one webchat without caring
    // what the registry currently offers.
    if (/^https?:\/\//i.test(id)) return { url: id.replace(/\/+$/, '') };

    let parsed = null;
    try { parsed = models.parse(id); } catch { parsed = null; }
    const site = parsed && parsed.site ? parsed.site : id.replace(/^webchat\//, '').split('/')[0];
    if (!site) return { error: `cannot tell which webchat "${id}" belongs to` };

    const gate = gates.find((g) => g.site === site);
    if (!gate) return { error: `no connected webchat serves "${site}"` };
    if (!gate.gatewayPort) return { error: `the "${site}" gateway has no port` };
    return { url: `http://127.0.0.1:${gate.gatewayPort}`, site };
}

// ★ A relay needs a CONNECT timeout and a response timeout, and it had neither.
// getJson() directly below sets one, so the omission was an oversight rather than a
// decision. Without it a gateway that accepts the socket and then never answers holds the
// hub's request open forever: the caller sees a hang with no error, cannot tell it from a
// slow model, and has no way to recover. The harness's own send gate sleeps 20-80s before
// each send, so the response budget has to clear that — hence 180s, not 30s.
const RELAY_CONNECT_MS = Number(process.env.HUB_RELAY_CONNECT_MS || 10000);
const RELAY_RESPONSE_MS = Number(process.env.HUB_RELAY_RESPONSE_MS || 180000);

function relay(target, reqPath, body, cb) {
    const url = new URL(reqPath, target.url);
    const payload = body == null ? null : Buffer.from(
        typeof body === 'string' ? body : JSON.stringify(body)
    );
    let settled = false;
    const done = (err, res) => {
        if (settled) return;
        settled = true;
        cb(err, res);
    };
    const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        // Time to establish the connection.
        timeout: RELAY_CONNECT_MS,
        headers: {
            'content-type': 'application/json',
            ...(payload ? { 'content-length': payload.length } : {}),
        },
    }, (res) => {
        // Headers arrived, so the connect timeout no longer applies; the response body may
        // legitimately take minutes. Guard only against a stalled stream.
        res.setTimeout(RELAY_RESPONSE_MS, () => {
            res.destroy(new Error(`no data for ${RELAY_RESPONSE_MS}ms`));
        });
        done(null, res);
    });
    req.on('timeout', () => {
        // The socket-level timeout fires when the connection itself stalls.
        req.destroy(new Error(`gateway did not answer within ${RELAY_CONNECT_MS}ms`));
    });
    req.on('error', (e) => done(e));
    if (payload) req.write(payload);
    req.end();
}

function getJson(url, timeoutMs, cb) {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
            try { cb(null, JSON.parse(raw)); } catch (e) { cb(e); }
        });
    });
    req.on('error', (e) => cb(e));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
}

// Every model the connected webchats offer, in one list. A gate that is down is
// skipped rather than failing the whole list: a dead webchat must not hide the others.
async function collectModels(gates, models) {
    const out = [];
    const seen = new Set();
    for (const g of gates) {
        if (!g.gatewayPort) continue;
        const ids = new Promise((resolve) => {
            getJson(`http://127.0.0.1:${g.gatewayPort}/v1/models`, 4000, (err, data) => {
                if (err || !data || !Array.isArray(data.data)) return resolve([]);
                resolve(data.data.map((m) => m && m.id).filter(Boolean));
            });
        });
        // Fall back to the registry if the gateway cannot answer, so a webchat that is
        // still starting does not vanish from the list.
        let list = await ids;
        if (!list.length) { try { list = models.modelIdsFor(g.site); } catch { list = []; } }
        for (const id of list) { if (!seen.has(id)) { seen.add(id); out.push(id); } }
    }
    return out;
}

function createHub(opts) {
    const gates = () => (opts.readGates ? opts.readGates() : []);
    const models = opts.models;
    const log = opts.log || (() => {});

    return http.createServer((req, res) => {
        const send = (code, obj) => {
            const b = Buffer.from(JSON.stringify(obj));
            res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
            res.end(b);
        };

        if (req.method === 'GET' && (req.url === '/v1/models' || req.url.startsWith('/v1/models?'))) {
            collectModels(gates(), models).then((ids) => {
                send(200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'webchat' })) });
            });
            return;
        }

        if (req.method === 'GET' && (req.url === '/health' || req.url.startsWith('/health?'))) {
            const gs = gates();
            send(200, { ok: true, role: 'hub', webchats: gs.map((g) => ({ site: g.site, gatewayPort: g.gatewayPort })) });
            return;
        }

        const path = req.url.split('?')[0];
        const routed = path === '/v1/chat/completions' || path === '/v1/messages' || path === '/v1/responses';
        if (req.method !== 'POST' || !routed) {
            send(404, { error: { message: `the hub only serves /v1/models, /v1/chat/completions, /v1/messages and /v1/responses (got ${req.method} ${path})` } });
            return;
        }

        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body;
            try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: { message: 'the request body was not valid JSON' } }); }

            const t = targetFor(body.model, gates(), models);
            if (t.error) {
                // 404 mirrors what an OpenAI-compatible client expects for an unknown
                // model, and the message names the fix rather than the symptom.
                return send(404, { error: { message: t.error, type: 'invalid_request_error' } });
            }
            log(`→ ${body.model} => ${t.url}${path}`);
            relay(t, path, body, (err, upstream) => {
                if (err) {
                    return send(502, { error: { message: `the ${t.site || ''} gateway did not answer: ${err.message}` } });
                }
                // Relay verbatim, including the stream. Buffering breaks SSE, and
                // rewriting the body would mean the hub has an opinion about the
                // protocol.
                res.writeHead(upstream.statusCode || 502, {
                    ...upstream.headers,
                    // The upstream sets its own length; chunked is safer once we pipe.
                    'transfer-encoding': upstream.headers['transfer-encoding'] || 'chunked',
                });
                upstream.pipe(res);
            });
        });
    });
}

module.exports = { createHub, targetFor, collectModels };
