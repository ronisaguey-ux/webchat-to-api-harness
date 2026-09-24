'use strict';
//
// swarm.js — spread many prompts across every webchat lane at once.
//
// Why: one webchat lane serialises its sends (a tab is one conversation thread, and the
// gateway holds a send mutex), so N tasks asked of one lane cost the SUM of N answers.
// This spreads them across every lane in parallel, which is the difference between
// "ten tasks take ten minutes" and "ten tasks take one minute".
//
// It talks to the aggregate fan-in rather than to individual lane gateways, for the reason
// the subagent worker does: a lane gateway rejects an unauthenticated request with a 401
// that reads like a malformed call, while the aggregate supplies whatever auth each lane
// needs and exposes them as short aliases.

const http = require('http');

function safeRequire(p) {
    try { return require(p); } catch { return null; }
}
const gatesMod = safeRequire('../../cli/gates');

const GATE_ALIAS = { deepseek: 'ds', gemini: 'gm', chatgpt: 'cg' };
const AGGREGATE = () => process.env.HARNESS_AGGREGATE_URL || 'http://127.0.0.1:8090';

function post(url, body, timeoutMs) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad url' }); }
        const data = Buffer.from(JSON.stringify(body));
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: timeoutMs,
            headers: { 'content-type': 'application/json', 'content-length': data.length },
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch { /* non-JSON is still an answer */ }
                resolve({ ok: true, status: res.statusCode, body: parsed, raw });
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timed out after ' + timeoutMs + 'ms')); });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.write(data);
        req.end();
    });
}

// Which lanes can actually answer. A gate is usable when its browser is attached — a
// gateway that is up but has no browser will fail every request, so including it just
// wastes a task slot and makes the swarm look slower.
async function reachableLanes(explicit) {
    const all = gatesMod ? gatesMod.read().gates : [];
    const wanted = explicit && explicit.length
        ? all.filter((g) => explicit.includes(g.id))
        : all;
    const usable = [];
    for (const g of wanted) {
        const h = await new Promise((resolve) => {
            const u = new URL('http://127.0.0.1:' + g.gatewayPort + '/health');
            const req = http.request({ hostname: u.hostname, port: u.port, path: '/health', method: 'GET', timeout: 4000 }, (res) => {
                let raw = '';
                res.on('data', (c) => { raw += c; });
                res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
            });
            req.on('timeout', () => req.destroy());
            req.on('error', () => resolve(null));
            req.end();
        });
        if (h && h.browserAlive) usable.push({ id: g.id, alias: GATE_ALIAS[g.id] || g.id, gatewayPort: g.gatewayPort });
    }
    // If nothing reports a live browser, fall back to every configured lane rather than
    // refusing: the health flag can lag an attach, and a swarm that refuses to start is
    // less useful than one that reports per-task errors.
    return usable.length ? usable : wanted.map((g) => ({ id: g.id, alias: GATE_ALIAS[g.id] || g.id, gatewayPort: g.gatewayPort }));
}

async function oneTask(lane, prompt, timeoutMs) {
    const t0 = Date.now();
    const r = await post(AGGREGATE() + '/v1/chat/completions', {
        model: lane.alias,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
    }, timeoutMs);
    const ms = Date.now() - t0;
    if (!r.ok) return { lane: lane.id, ok: false, elapsedMs: ms, error: r.error };
    if (r.status !== 200) {
        const msg = r.body && r.body.error && (r.body.error.message || r.body.error);
        return { lane: lane.id, ok: false, elapsedMs: ms, status: r.status, error: String(msg || r.raw).slice(0, 300) };
    }
    const c = ((r.body && r.body.choices && r.body.choices[0] && r.body.choices[0].message) || {}).content || '';
    return { lane: lane.id, ok: true, elapsedMs: ms, chars: c.length, answer: c };
}

// A bounded worker pool: at most `size` tasks in flight. Without a bound, a 50-task swarm
// opens 50 concurrent sends against a handful of lanes, every lane serialises them anyway,
// and the ones that queue past the client timeout fail for no reason.
async function pool(items, size, worker) {
    const out = new Array(items.length);
    let next = 0;
    const runners = new Array(Math.max(1, Math.min(size, items.length))).fill(0).map(async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return out;
}

async function runSwarm({ prompts, gates, concurrency, timeoutMs }) {
    if (!prompts || !prompts.length) return { ran: 0, results: [] };
    const lanes = await reachableLanes(gates);
    if (!lanes.length) return { ran: 0, results: [], error: 'no webchat lanes configured' };
    const timeout = Math.min(Math.max(Number(timeoutMs) || 300000, 5000), 1800000);
    const size = Math.min(Math.max(Number(concurrency) || lanes.length, 1), 32);
    const t0 = Date.now();

    const results = await pool(prompts, size * lanes.length, (prompt, i) => {
        // Round-robin so the work is spread, not piled on the first lane.
        const lane = lanes[i % lanes.length];
        return oneTask(lane, prompt, timeout);
    });

    const ok = results.filter((r) => r.ok).length;
    return {
        ran: results.length,
        succeeded: ok,
        failed: results.length - ok,
        lanes: lanes.map((l) => l.id),
        concurrency: size,
        elapsedMs: Date.now() - t0,
        results: results.map((r, i) => ({ task: i, ...r })),
    };
}

async function raceSwarm({ prompt, gates, timeoutMs }) {
    const lanes = await reachableLanes(gates);
    if (!lanes.length) return { ok: false, error: 'no webchat lanes configured' };
    const timeout = Math.min(Math.max(Number(timeoutMs) || 300000, 5000), 1800000);
    const t0 = Date.now();
    // Every lane gets the same prompt; Promise.all never rejects because oneTask resolves
    // with an error shape, so a dead lane cannot sink the race.
    const results = await Promise.all(lanes.map((l) => oneTask(l, prompt, timeout)));
    const first = results.slice().sort((a, b) => (a.elapsedMs || 1e9) - (b.elapsedMs || 1e9))[0];
    return {
        winner: first && first.ok ? first.lane : null,
        elapsedMs: Date.now() - t0,
        results: results.map((r) => ({ lane: r.lane, ok: r.ok, elapsedMs: r.elapsedMs, answer: r.answer || '', error: r.error || '' })),
    };
}

module.exports = { runSwarm, raceSwarm, reachableLanes };
