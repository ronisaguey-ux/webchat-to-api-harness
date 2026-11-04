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

import http = require('http');

function safeRequire(p: string): unknown {
    try { return require(p); } catch { return null; }
}

/** The one method swarm needs from cli/gates: the configured gateway list. */
interface GatesModule {
    read: () => { gates: GateConfig[] };
}

interface GateConfig {
    id: string;
    gatewayPort: number;
}

const gatesMod = safeRequire('../cli/gates') as GatesModule | null;

// The aggregate resolves model ids through its registry; the short ids (ds/gm/cg) are not
// in it. Use the qualified webchat/<gate> form, which parses on the hub and on a lane.

const AGGREGATE = (): string => process.env.HARNESS_AGGREGATE_URL || 'http://127.0.0.1:8090';

export interface Lane {
    id: string;
    alias: string;
    gatewayPort: number;
}

/** Body of a chat/health reply — parsed JSON is `unknown` until narrowed. */
export interface HttpResult {
    ok: boolean;
    status?: number;
    headers?: http.IncomingHttpHeaders;
    body?: unknown;
    raw?: string;
    error?: string;
    cancelled?: boolean;
}

export interface TaskResult {
    lane: string;
    ok: boolean;
    elapsedMs: number;
    status?: number;
    error?: string;
    cancelled?: boolean;
    chars?: number;
    answer?: string;
}

export interface SwarmOptions {
    prompts?: string[];
    gates?: string[] | null;
    concurrency?: number;
    timeoutMs?: number;
}

export interface SwarmSummary {
    ran: number;
    results: Array<Record<string, unknown>>;
    error?: string;
    succeeded?: number;
    failed?: number;
    lanes?: string[];
    concurrency?: number;
    elapsedMs?: number;
}

export interface RaceSummary {
    ok?: boolean;
    error?: string;
    winner: string | null;
    answer: string;
    elapsedMs: number;
    results: Array<{
        lane: string;
        ok: boolean;
        elapsedMs: number;
        answer: string;
        error: string;
    }>;
}

/** Narrow a parsed JSON value to an object without assuming its shape. */
function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function post(
    url: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<HttpResult> {
    return new Promise((resolve) => {
        if (signal && signal.aborted) return resolve({ ok: false, error: 'cancelled', cancelled: true });
        let u: URL;
        try { u = new URL(url); } catch { return resolve({ ok: false, error: 'bad url' }); }
        const data = Buffer.from(JSON.stringify(body));
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: timeoutMs,
            headers: { 'content-type': 'application/json', 'content-length': data.length },
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c: string) => { raw += c; });
            res.on('end', () => {
                let parsed: unknown = null;
                try { parsed = JSON.parse(raw) as unknown; } catch { /* non-JSON is still an answer */ }
                resolve({ ok: true, status: res.statusCode, headers: res.headers, body: parsed, raw });
            });
        });
        if (signal) {
            signal.addEventListener('abort', () => {
                req.destroy();
                resolve({ ok: false, error: 'cancelled', cancelled: true });
            }, { once: true });
        }
        req.on('timeout', () => { req.destroy(new Error('timed out after ' + timeoutMs + 'ms')); });
        req.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
        req.write(data);
        req.end();
    });
}

// Which lanes can actually answer. A gate is usable when its browser is attached — a
// gateway that is up but has no browser will fail every request, so including it just
// wastes a task slot and makes the swarm look slower.
async function reachableLanes(explicit?: string[] | null): Promise<Lane[]> {
    const all: GateConfig[] = gatesMod ? gatesMod.read().gates : [];
    const wanted: GateConfig[] = explicit && explicit.length
        ? all.filter((g) => explicit.includes(g.id))
        : all;
    const usable: Lane[] = [];
    for (const g of wanted) {
        const h = await new Promise<Record<string, unknown> | null>((resolve) => {
            const u = new URL('http://127.0.0.1:' + g.gatewayPort + '/health');
            const req = http.request({ hostname: u.hostname, port: u.port, path: '/health', method: 'GET', timeout: 4000 }, (res) => {
                let raw = '';
                res.on('data', (c: string) => { raw += c; });
                res.on('end', () => {
                    try { resolve(asRecord(JSON.parse(raw) as unknown)); } catch { resolve(null); }
                });
            });
            req.on('timeout', () => req.destroy());
            req.on('error', () => resolve(null));
            req.end();
        });
        if (h && h.browserAlive) usable.push({ id: g.id, alias: 'webchat/' + g.id, gatewayPort: g.gatewayPort });
    }
    // If nothing reports a live browser, fall back to every configured lane rather than
    // refusing: the health flag can lag an attach, and a swarm that refuses to start is
    // less useful than one that reports per-task errors.
    return usable.length ? usable : wanted.map((g) => ({ id: g.id, alias: 'webchat/' + g.id, gatewayPort: g.gatewayPort }));
}

async function oneTask(lane: Lane, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskResult> {
    const t0 = Date.now();
    const r = await post(AGGREGATE() + '/v1/chat/completions', {
        model: lane.alias,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
    }, timeoutMs, signal);
    const ms = Date.now() - t0;
    if (!r.ok) return { lane: lane.id, ok: false, elapsedMs: ms, error: r.error, cancelled: !!r.cancelled };
    if (r.status !== 200) {
        const body = asRecord(r.body);
        const errField = body ? body.error : undefined;
        const msg = errField && typeof errField === 'object'
            ? (asRecord(errField)?.message || errField)
            : errField;
        return { lane: lane.id, ok: false, elapsedMs: ms, status: r.status, error: String(msg || r.raw).slice(0, 300) };
    }
    // A 200 is not an answer by itself: a gateway that reports a non-ok outcome, or
    // an empty message, produced nothing a caller can use.
    const outcome = r.headers && r.headers['x-harness-outcome'];
    if (outcome && outcome !== 'ok') {
        return { lane: lane.id, ok: false, elapsedMs: ms, status: r.status, error: `gateway outcome ${outcome}` };
    }
    const body = asRecord(r.body);
    const choices = body && Array.isArray(body.choices) ? body.choices : [];
    const first = choices.length ? asRecord(choices[0]) : null;
    const message = first ? asRecord(first.message) : null;
    const c = message && typeof message.content === 'string' ? message.content : '';
    if (!String(c).trim()) {
        return { lane: lane.id, ok: false, elapsedMs: ms, status: r.status, error: 'empty answer' };
    }
    return { lane: lane.id, ok: true, elapsedMs: ms, chars: c.length, answer: c };
}

// A bounded worker pool: at most `size` tasks in flight. Without a bound, a 50-task swarm
// opens 50 concurrent sends against a handful of lanes, every lane serialises them anyway,
// and the ones that queue past the client timeout fail for no reason.
async function pool<T, R>(items: T[], size: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
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

async function runSwarm({ prompts, gates, concurrency, timeoutMs }: SwarmOptions): Promise<SwarmSummary> {
    if (!prompts || !prompts.length) return { ran: 0, results: [] };
    const lanes = await reachableLanes(gates);
    if (!lanes.length) return { ran: 0, results: [], error: 'no webchat lanes configured' };
    const timeout = Math.min(Math.max(Number(timeoutMs) || 300000, 5000), 1800000);
    const size = Math.min(Math.max(Number(concurrency) || lanes.length, 1), 32);
    const t0 = Date.now();

    const results = await pool(prompts, size * lanes.length, (prompt: string, i: number) => {
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

// A real race: the FIRST SUCCESSFUL lane wins and the others are cancelled.
//
// This used to await every lane (Promise.all — so a race cost the SLOWEST lane) and
// then pick the lowest elapsedMs over ALL results, failures included: a lane that
// errored in 2s "won" against a correct answer in 90s, and winner came back null
// although a lane had succeeded.
async function raceLanes(lanes: Lane[], prompt: string, timeout: number): Promise<RaceSummary> {
    const t0 = Date.now();
    const ctl = new AbortController();
    const results: Array<TaskResult | undefined> = new Array<TaskResult | undefined>(lanes.length);
    // Assigned from inside the lane closures below, so it is read back through a cast:
    // control-flow analysis cannot see a write that happens in an async callback.
    let winner: TaskResult | null = null;
    await new Promise<void>((resolve) => {
        let pending = lanes.length;
        lanes.forEach((l, i) => {
            oneTask(l, prompt, timeout, ctl.signal).then((r) => {
                results[i] = r;
                if (r.ok && !winner) {
                    winner = r;
                    ctl.abort(); // the rest are no longer needed
                    resolve();
                }
                if (--pending === 0) resolve();
            });
        });
    });
    const found = winner as TaskResult | null;
    return {
        winner: found ? found.lane : null,
        answer: found ? (found.answer ?? '') : '',
        elapsedMs: Date.now() - t0,
        results: lanes.map((l, i) => {
            const r: TaskResult = results[i] || { lane: l.id, ok: false, elapsedMs: 0, error: 'cancelled', cancelled: true };
            return { lane: r.lane, ok: r.ok, elapsedMs: r.elapsedMs, answer: r.answer || '', error: r.error || '' };
        }),
    };
}

async function raceSwarm({ prompt, gates, timeoutMs }: { prompt: string; gates?: string[] | null; timeoutMs?: number }): Promise<RaceSummary> {
    const lanes = await reachableLanes(gates);
    if (!lanes.length) {
        return { ok: false, error: 'no webchat lanes configured', winner: null, answer: '', elapsedMs: 0, results: [] };
    }
    const timeout = Math.min(Math.max(Number(timeoutMs) || 300000, 5000), 1800000);
    return raceLanes(lanes, prompt, timeout);
}

export = { runSwarm, raceSwarm, raceLanes, oneTask, reachableLanes };
