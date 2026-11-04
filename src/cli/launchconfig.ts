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
import fs = require('fs');
import os = require('os');
import path = require('path');
import d = require('./daemon');

// The directory the agent is launched INTO, and the only place this CLI writes an
// agent config. It used to default to the user's HOME, which was wrong in two ways:
// the generated opencode.json landed in ~ where opencode merges it with the user's
// OWN global config, and the agent then started on a paid provider while the harness
// sat unused. One private folder per install, created on demand.
export interface LaunchConfig {
    gates: string[];
    harnesses: string[];
    mode: string;
    args: string[];
    cwd: string;
    updatedAt: string | null;
    error?: string;
}

export interface ValidationResult {
    ok: boolean;
    problems: string[];
}

function agentDir(): string {
    return path.join(os.homedir(), '.webchat', 'agent');
}

function ensureAgentDir(): string {
    const dir = agentDir();
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    return dir;
}

const file = () => path.join(d.stateDir(), 'launch.json');

const DEFAULT: LaunchConfig = {
    // Gate ids to bring up and connect, in order. The first is the primary.
    gates: [],
    // Harness ids to launch. One per terminal; the CLI launches the first here and
    // prints the command for the rest.
    harnesses: [],
    // manual | auto | yolo
    mode: 'auto',
    // Extra argv appended to every harness launch.
    args: [],
    // Working directory the harness starts in. NOT the user's home: the agent gets its
    // own folder holding only the config we generate for it.
    cwd: agentDir(),
    updatedAt: null,
};

function read(): LaunchConfig {
    const f = file();
    if (!fs.existsSync(f)) return { ...DEFAULT };
    try {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8')) as Partial<LaunchConfig>;
        const merged: LaunchConfig = { ...DEFAULT, ...parsed };
        // Migrate a saved config that still points at HOME (the old default). Leaving it
        // would keep writing opencode.json into the user's home directory forever.
        if (merged.cwd === process.env.HOME) merged.cwd = agentDir();
        return merged;
    } catch {
        return { ...DEFAULT, error: 'launch.json is not valid JSON — using defaults' };
    }
}

function write(cfg: Partial<LaunchConfig>): LaunchConfig {
    d.ensureStateDir();
    const f = file();
    const next = { ...DEFAULT, ...read(), ...cfg, updatedAt: new Date().toISOString() };
    if (!next.cwd || next.cwd === process.env.HOME) next.cwd = agentDir();
    ensureAgentDir();
    const tmp = `${f}.tmp`;
    // Atomic: `webchat connect` may be reading this at the moment the menu writes it.
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    return next;
}

function clear(): void {
    const f = file();
    try { fs.unlinkSync(f); } catch { /* already gone */ }
}

// Fill in what the machine can answer for itself, so `connect` never sends the user to
// another terminal to configure things that are already true. `gates` is the gate list,
// `pickHarness` returns an installed harness id (or null). Pure: no I/O, so it is testable.
function autofill(
    cfg: Partial<LaunchConfig>,
    gates: Array<{ id: string; connected?: boolean }> | null | undefined,
    pickHarness: string | null | (() => string | null),
): { cfg: LaunchConfig; filled: Partial<LaunchConfig> } {
    const filled: Partial<LaunchConfig> = {};
    if (!cfg.gates || !cfg.gates.length) {
        const ready = (gates || []).filter((g) => g.connected !== false).map((g) => g.id);
        if (ready.length) filled.gates = [ready[0]];
    }
    if (!cfg.harnesses || !cfg.harnesses.length) {
        const h = typeof pickHarness === 'function' ? pickHarness() : pickHarness;
        if (h) filled.harnesses = [h];
    }
    return { cfg: { ...DEFAULT, ...cfg, ...filled }, filled };
}

// Is this config ready to run? Returns the reasons it is not, so the CLI can say
// what is missing instead of launching something half-configured.
function validate(cfg: LaunchConfig, gates: Array<{ id: string }> | null | undefined): ValidationResult {
    const problems: string[] = [];
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
function summarize(cfg: LaunchConfig): string {
    const parts: string[] = [];
    parts.push(cfg.gates.length ? cfg.gates.join(' + ') : 'no gates');
    parts.push(cfg.harnesses && cfg.harnesses.length ? cfg.harnesses.join(' + ') : 'no harness');
    parts.push(cfg.mode);
    return parts.join('  ·  ');
}

export = { read, write, clear, validate, summarize, autofill, DEFAULT, file, agentDir, ensureAgentDir };
