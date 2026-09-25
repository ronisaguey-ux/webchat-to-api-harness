'use strict';
//
// subagents.js — run webchat tasks in the BACKGROUND, many at once.
//
// Why this exists rather than just calling the gateway: `webchat_ask` holds the request
// open for the whole answer, and a real task on a webchat takes minutes. One agent asking
// three webchats to do three things therefore takes the SUM of all three, and an MCP tool
// call that runs for ten minutes occupies the caller's turn the entire time.
//
// Here each job is a detached process that POSTs to its gate's gateway and writes the
// result to a file. The caller gets an id immediately, can start more, and polls. That is
// what makes them subagents rather than function calls.
//
// State lives on disk (`state/subagents/<id>.json`) and not in memory, because the MCP
// server is a stdio process the client may restart between calls — an in-memory registry
// would lose every job on a reconnect and report "no such job" for work that is still
// running. The file is the record; the pid inside it is how a live job is found.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PATHS = require('../core/paths');

const MAX_JOBS = 200;          // keep the directory bounded
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function dir() {
    const d = path.join(PATHS.workspaceRoot(), 'state', 'subagents');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function jobFile(id) {
    // ★ An id must never escape state/subagents. `path.join(dir(), `${id}.json`)` resolves
    // `..`, so an id of `../../secret` read a file anywhere on disk — verified by driving it:
    // readJob('../../secret') returned a JSON file planted two levels up. The id comes from a
    // caller (the MCP exposes webchat_subagent_result with an id), so it is untrusted input,
    // not an internal detail.
    //
    // Only the basename is kept and any residual separator is rejected, so a path-shaped id
    // fails closed instead of silently resolving somewhere else. A legitimate id (pid + random
    // suffix) never contains a separator, so nothing real is lost.
    const safe = String(id == null ? '' : id);
    if (!safe || safe.includes('/') || safe.includes('\\') || safe.includes('..')) {
        throw new Error(`subagents: invalid job id ${JSON.stringify(safe)}`);
    }
    return path.join(dir(), `${safe}.json`);
}

function readJob(id) {
    // ★ Validate the id OUTSIDE the try. `jobFile` throws on a path-shaped id, but this
    // function's own catch swallowed that and returned null — so an invalid id was
    // indistinguishable from a job that does not exist. A caller that cannot tell a bad
    // argument from an empty result cannot report the difference to a user.
    const file = jobFile(id);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJob(job) {
    fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
    return job;
}

function allJobs() {
    const d = dir();
    let files = [];
    try {
        files = fs.readdirSync(d).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    return files.map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
}

// A job is only "running" if its process still exists. Checking the pid rather than
// trusting the recorded state is what stops a killed process from reporting "running"
// forever — a job whose process died without writing a result is marked failed here, once.
function refresh(job) {
    if (job.state !== 'running') return job;
    if (job.pid) {
        try {
            process.kill(job.pid, 0);
            return job;                     // still alive
        } catch {
            // process is gone — the wrapper either finished or died
        }
    }
    // Give the wrapper a moment to have written its result before calling it dead.
    const age = Date.now() - new Date(job.startedAt).getTime();
    if (age < 15000) return job;
    job.state = 'failed';
    job.error = job.error || 'the subagent process exited without writing a result';
    job.finishedAt = new Date().toISOString();
    return writeJob(job);
}

function spawnJob(opts) {
    const { prompt, gate, label, timeoutMs } = opts;
    const id = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5000), 6 * 60 * 60 * 1000);

    const job = {
        id,
        label: label || String(prompt).split('\n')[0].slice(0, 60),
        gate,
        state: 'running',
        startedAt: new Date().toISOString(),
        timeoutMs: timeout,
        // ★ THE FULL PROMPT MUST BE STORED, NOT JUST A PREVIEW. It was preview-only, and
        // the worker reads `job.prompt` — so every subagent sent an EMPTY prompt. Measured
        // 2026-09-24: a job asked for "SUBAGENT-OK" and the webchat answered "Ready for
        // instructions.", which looked like a working round trip and was actually the
        // model replying to nothing. A plausible wrong answer is far harder to notice than
        // an error, so this is a test-enforced invariant now.
        prompt: String(prompt),
        promptPreview: String(prompt).slice(0, 300),
        resultFile: path.join(dir(), `${id}.result.txt`),
        errorFile: path.join(dir(), `${id}.error.txt`),
        pid: null,
    };
    writeJob(job);

    // The child is a detached node process, so it survives this server restarting and so
    // several run at once. It talks to the gateway over HTTP like any other client.
    const helper = path.join(__dirname, 'subagent-run.js');
    const child = spawn(process.execPath, [helper, id], {
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, { WEBCHAT_SUBAGENT_JOB: id }),
    });
    child.unref();

    job.pid = child.pid;
    writeJob(job);
    prune();
    return job;
}

function prune() {
    const jobs = allJobs().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    for (const stale of jobs.slice(MAX_JOBS)) {
        try { fs.unlinkSync(jobFile(stale.id)); } catch { /* already gone */ }
    }
}

function list(opts = {}) {
    let jobs = allJobs().map(refresh);
    if (opts.state) jobs = jobs.filter((j) => j.state === opts.state);
    jobs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const counts = jobs.reduce((acc, j) => { acc[j.state] = (acc[j.state] || 0) + 1; return acc; }, {});
    return {
        counts,
        jobs: jobs.map((j) => ({
            id: j.id,
            label: j.label,
            gate: j.gate,
            state: j.state,
            startedAt: j.startedAt,
            finishedAt: j.finishedAt || null,
            elapsedSec: Math.round((Date.now() - new Date(j.startedAt).getTime()) / 1000),
            chars: j.chars || 0,
            preview: (j.preview || j.error || '').slice(0, 160),
        })),
    };
}

function readResult(job) {
    try { return fs.readFileSync(job.resultFile, 'utf8'); } catch { return ''; }
}
function readError(job) {
    try { return fs.readFileSync(job.errorFile, 'utf8'); } catch { return ''; }
}

async function result(id, waitMs = 0) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        let job = readJob(id);
        if (!job) return null;
        job = refresh(job);
        if (job.state !== 'running') {
            return {
                id: job.id,
                label: job.label,
                gate: job.gate,
                state: job.state,
                elapsedSec: Math.round(((job.finishedAt ? new Date(job.finishedAt) : Date.now())
                    - new Date(job.startedAt)) / 1000),
                answer: job.state === 'done' ? readResult(job) : '',
                error: job.state === 'done' ? '' : (job.error || readError(job) || ''),
            };
        }
        if (Date.now() >= deadline) {
            return {
                id: job.id, label: job.label, gate: job.gate, state: 'running',
                elapsedSec: Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000),
                answer: '', error: '',
                note: 'Still running. Poll again, or spawn other work while it finishes.',
            };
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1000));
    }
}

function cancel(id) {
    const job = readJob(id);
    if (!job) return { ok: false, reason: 'no job with id ' + id };
    if (job.state !== 'running') return { ok: true, id, state: job.state, note: 'job had already finished' };
    if (job.pid) {
        try { process.kill(-job.pid, 'SIGKILL'); } catch {
            try { process.kill(job.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
    }
    job.state = 'cancelled';
    job.finishedAt = new Date().toISOString();
    writeJob(job);
    return { ok: true, id, state: 'cancelled' };
}

module.exports = { spawn: spawnJob, list, result, cancel, dir, readJob, writeJob };
