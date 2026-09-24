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

const fs = require('fs');
const path = require('path');
const http = require('http');

const sub = require('./subagents');
const PATHS = require('../core/paths');
const gates = require('../../cli/gates');

const id = process.argv[2];
if (!id) process.exit(2);

const job = sub.readJob(id);
if (!job) process.exit(3);

function fail(message) {
    try { fs.writeFileSync(job.errorFile, String(message)); } catch { /* nothing to do */ }
    job.state = 'failed';
    job.error = String(message).slice(0, 500);
    job.finishedAt = new Date().toISOString();
    sub.writeJob(job);
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
const GATE_ALIAS = { deepseek: 'ds', gemini: 'gm', chatgpt: 'cg' };
const alias = GATE_ALIAS[job.gate];

let useAggregate = Boolean(alias);
let port = null;
let model = 'webchat/' + job.gate;

if (useAggregate) {
    try {
        const u = new URL(AGGREGATE);
        port = parseInt(u.port || '80', 10);
        model = alias;
    } catch { useAggregate = false; }
}
if (!useAggregate) {
    // Resolve the gate's gateway port at RUN time, not from the job record: the port is a
    // property of the webchat, and a stale copy in the job file would send the request to
    // whatever else happens to be listening.
    try {
        const { gates: all } = gates.read();
        const g = all.find((x) => x.id === job.gate);
        if (g) port = g.gatewayPort;
    } catch { /* fall through to the environment */ }
    if (!port) port = parseInt(process.env.PORT || '8081', 10);
}

const body = Buffer.from(JSON.stringify({
    model,
    messages: [{ role: 'user', content: job.prompt }],
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
    res.on('data', (c) => { raw += c; });
    res.on('end', () => {
        // The gateway answers non-200 with a JSON error body, and that body IS the
        // diagnosis — surface it rather than a bare status code.
        if (res.statusCode !== 200) {
            return fail(`gateway HTTP ${res.statusCode}: ${raw.slice(0, 400)}`);
        }
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* handled below */ }
        const choice = parsed && parsed.choices && parsed.choices[0];
        const answer = choice && choice.message && typeof choice.message.content === 'string'
            ? choice.message.content
            : '';
        if (!answer) {
            return fail('the webchat returned no message content (it may have replied with only a tool call, or the tab is wedged)');
        }
        try { fs.writeFileSync(job.resultFile, answer); } catch (e) { return fail('could not write the result: ' + e.message); }
        job.state = 'done';
        job.chars = answer.length;
        job.preview = answer.replace(/\s+/g, ' ').slice(0, 200);
        job.finishedAt = new Date().toISOString();
        delete job.error;
        sub.writeJob(job);
        process.exit(0);
    });
});

req.on('error', (e) => fail('gateway unreachable on 127.0.0.1:' + port + ' — ' + e.message));

// The job's own timeout is enforced here as well as by the poller, so a wedged tab is
// abandoned and reported instead of leaving a process alive for the rest of the session.
const t = setTimeout(() => {
    try { req.destroy(new Error('timed out')); } catch { /* gone */ }
    fail(`timed out after ${Math.round(job.timeoutMs / 1000)}s`);
}, job.timeoutMs || 1800000);
if (t.unref) t.unref();

req.write(body);
req.end();
