'use strict';
//
// launchconfig.js — the primed selection.
//
// The owner's model, in their words: everything is chosen inside the main `webchat`
// CLI, and then `webchat connect` "just connects and launches whatever config was
// selected and primed".
//
// So this file is the handoff between the two commands. The main CLI WRITES it as the
// user picks; `webchat connect` READS it and does exactly what it says. Nothing is
// re-asked at connect time — a connect that starts prompting is not a thin executor.
//
// It is plain JSON, on purpose: a user can inspect what is about to happen, or write
// it by hand and skip the menus entirely.
//
const fs = require('fs');
const path = require('path');
const d = require('./daemon');

const file = () => path.join(d.stateDir(), 'launch.json');

const DEFAULT = {
    // Gate ids to bring up and connect, in order. The first is the primary.
    gates: [],
    // Harness ids to launch. One per terminal; the CLI launches the first here and
    // prints the command for the rest.
    harnesses: [],
    // manual | auto | yolo
    mode: 'auto',
    // Extra argv appended to every harness launch.
    args: [],
    // Working directory the harness starts in.
    cwd: process.env.HOME || '/',
    updatedAt: null,
};

function read() {
    const f = file();
    if (!fs.existsSync(f)) return { ...DEFAULT };
    try {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
        return { ...DEFAULT, ...parsed };
    } catch {
        return { ...DEFAULT, error: 'launch.json is not valid JSON — using defaults' };
    }
}

function write(cfg) {
    d.ensureStateDir();
    const f = file();
    const next = { ...DEFAULT, ...read(), ...cfg, updatedAt: new Date().toISOString() };
    const tmp = `${f}.tmp`;
    // Atomic: `webchat connect` may be reading this at the moment the menu writes it.
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    return next;
}

function clear() {
    const f = file();
    try { fs.unlinkSync(f); } catch { /* already gone */ }
}

// Is this config ready to run? Returns the reasons it is not, so the CLI can say
// what is missing instead of launching something half-configured.
function validate(cfg, gates) {
    const problems = [];
    if (!cfg.gates.length) problems.push('no webchat gate selected');
    const known = new Set((gates || []).map((g) => g.id));
    for (const id of cfg.gates) {
        if (!known.has(id)) problems.push(`gate "${id}" is selected but no longer exists`);
    }
    if (!cfg.harnesses || !cfg.harnesses.length) problems.push('no agentic harness selected');
    if (!['manual', 'auto', 'yolo'].includes(cfg.mode)) problems.push(`unknown permission mode "${cfg.mode}"`);
    return { ok: problems.length === 0, problems };
}

// A one-line description of what connect will do, for the dashboard.
function summarize(cfg) {
    const parts = [];
    parts.push(cfg.gates.length ? cfg.gates.join(' + ') : 'no gates');
    parts.push(cfg.harnesses && cfg.harnesses.length ? cfg.harnesses.join(' + ') : 'no harness');
    parts.push(cfg.mode);
    return parts.join('  ·  ');
}

module.exports = { read, write, clear, validate, summarize, DEFAULT, file };
