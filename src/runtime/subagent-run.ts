'use strict';
//
// subagent-run.js — the detached worker behind `webchat_subagent_spawn`.
//
// Reads its job from state/subagents/<id>.json, POSTs the prompt to that webchat's
// gateway, and writes the answer (or the failure) next to the job. It is a separate
// process on purpose: the MCP server is a stdio process that the client may restart, and
// a task must not die with it.
//
// Everything is written to FILES rather than returned, because nothing is listening to
// this process's stdout — it is detached with stdio ignored so it cannot hold a pipe open.
//
// Usage: node subagent-run.js <job-id>
//
// Not a tool: it is executed, never required.

import fs = require('fs');
import path = require('path');
import http = require('http');

import sub = require('./subagents');
import PATHS = require('../core/paths');
import gates = require('../cli/gates');

const id = process.argv[2];
if (!id) process.exit(2);

const job = sub.readJob(id);
if (!job) process.exit(3);
const jobRecord: sub.SubagentJob = job;

function fail(message: unknown): never {
    const text = String(message);
    try { fs.writeFileSync(jobRecord.errorFile, text); } catch { /* nothing to do */ }
    jobRecord.state = 'failed';
    jobRecord.error = text.slice(0, 500);
    jobRecord.finishedAt = new Date().toISOString();
    sub.writeJob(jobRecord);
    process.exit(0);
}

// WHERE THE REQUEST GOES.
//
// Not straight at the gate's own gateway: those are per-lane servers, some of which
// (the gemini lane, measured 2026-09-24) refuse an unauthenticated request with
// "Authentication Fails (auth header format should be Bearer sk-...)" — a 401 that reads
// like our call is malformed when the real cause is that the lane wants a token only the
// fan-in knows. The aggregate on :8090 fronts every lane, supplies whatever auth each one
// needs, and exposes them as short aliases (ds, gm, cg), which is exactly the interface a
// caller should have to think about.
//
// A gate with no aggregate alias still falls back to its own gateway, so a newly added
// webchat keeps working without a code change.
const AGGREGATE = process.env.HARNESS_AGGREGATE_URL || 'http://127.0.0.1:8090';

let useAggregate = true;
let port: number | null = null;
const model = 'webchat/' + jobRecord.gate;

try {
    const u = new URL(AGGREGATE);
    port = parseInt(u.port || '80', 10);
} catch { useAggregate = false; }
if (!useAggregate) {
    // Resolve the gate's gateway port at RUN time, not from the job record: the port is a
    // property of the webchat, and a stale copy in the job file would send the request to
    // whatever else happens to be listening.
    try {
        const { gates: all } = gates.read();
        const g = all.find((x: { id: string; gatewayPort: number }) => x.id === jobRecord.gate);
        if (g) port = g.gatewayPort;
    } catch { /* fall through to the environment */ }
    if (!port) port = parseInt(process.env.PORT || '8081', 10);
}

const body = Buffer.from(JSON.stringify({
    model,
    messages: [{ role: 'user', content: jobRecord.prompt }],
    stream: false,
}));

const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': body.length },
}, (res) => {
    let raw = '';
    res.setEncoding('utf-8');
    res.on('data', (c: string) => { raw += c; });
    res.on('end', () => {
        // The gateway answers non-200 with a JSON error body, and that body IS the
        // diagnosis — surface it rather than a bare status code.
        if (res.statusCode !== 200) {
            return fail(`gateway HTTP ${res.statusCode}: ${raw.slice(0, 400)}`);
        }
        let parsed: unknown = null;
        try { parsed = JSON.parse(raw) as unknown; } catch { /* handled below */ }
        const body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
        const choices = Array.isArray(body.choices) ? body.choices : [];
        const choice = choices.length && choices[0] && typeof choices[0] === 'object'
            ? choices[0] as Record<string, unknown>
            : {};
        const message = choice.message && typeof choice.message === 'object'
            ? choice.message as Record<string, unknown>
            : {};
        const answer = typeof message.content === 'string' ? message.content : '';
        // A 200 is not proof of an answer: the gateway reports an unfinished turn in
        // X-Harness-Outcome, and an older gateway put the same verdict in the body as
        // "[⚠️ Harness stopped: …]" text. Either one is a failure of the task, and must
        // not be written out as its result.
        const outcome = res.headers['x-harness-outcome'];
        if (outcome && outcome !== 'ok') {
            return fail(`gateway outcome ${outcome}: ${answer.slice(0, 400)}`);
        }
        if (!answer.trim()) {
            return fail('the webchat returned no message content (it may have replied with only a tool call, or the tab is wedged)');
        }
        if (/^\s*\[⚠️/.test(answer)) {
            return fail('the gateway stopped without an answer: ' + answer.slice(0, 400));
        }
        try { fs.writeFileSync(jobRecord.resultFile, answer); } catch (e) { return fail('could not write the result: ' + (e as Error).message); }
        jobRecord.state = 'done';
        jobRecord.chars = answer.length;
        jobRecord.preview = answer.replace(/\s+/g, ' ').slice(0, 200);
        jobRecord.finishedAt = new Date().toISOString();
        delete jobRecord.error;
        sub.writeJob(jobRecord);
        process.exit(0);
    });
});

req.on('error', (e: Error) => fail('gateway unreachable on 127.0.0.1:' + port + ' — ' + e.message));

// The job's own timeout is enforced here as well as by the poller, so a wedged tab is
// abandoned and reported instead of leaving a process alive for the rest of the session.
const t = setTimeout(() => {
    try { req.destroy(new Error('timed out')); } catch { /* gone */ }
    fail(`timed out after ${Math.round((jobRecord.timeoutMs ?? 0) / 1000)}s`);
}, jobRecord.timeoutMs || 1800000);
if (t.unref) t.unref();

req.write(body);
req.end();
