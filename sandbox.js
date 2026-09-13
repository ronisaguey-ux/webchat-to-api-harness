'use strict';
// sandbox.js — path sandbox for the webchat-to-api harness.
//
// WHY: every file tool in this harness executes paths that come from a webchat
// model's output. Without a fence, a prompt-injected or simply confused model
// can read/write anywhere the process user can reach (SSH keys, .env files,
// other projects). The sandbox restricts every file path AND the paths a bash
// command touches to an explicit, configurable allowlist of roots.
//
// CONFIGURE (env, or the matching keys in config.js):
//   SANDBOX_ENABLED=true|false     default: true
//   SANDBOX_ROOTS=/a,/b,/c         default: the OCULUS_RELEVANT_ROOTS below
//   SANDBOX_ALLOW_BASH=true|false  default: false — run_bash stays blocked by
//                                  the sandbox even when BASH_ALLOWED=true
//   SANDBOX_LOG=true|false         default: true — log every denial
//
// Adding a root is one entry in SANDBOX_ROOTS. No code change, no restart of
// anything else: config.js is read once at process start, so restart the
// gateway after editing .env.
//
// SECURITY MODEL (read this before loosening it):
//   - Paths are resolved with realpath BEFORE the prefix test, so `..`
//     traversal and symlinks pointing outside a root are both rejected.
//   - A not-yet-existing target (write_file) is resolved against its nearest
//     existing ancestor, so `foo/../../etc/passwd` still fails.
//   - The prefix test appends a separator, so `/root/oculus-evil` does NOT
//     match the root `/root/oculus`.
//   - Bash is checked by extracting path-like tokens; anything absolute or
//     containing `..` that resolves outside the roots is denied. This is a
//     guardrail, not a jail — see the caveat in the README.

const fs = require('fs');
const PATHS = require('./paths');
const path = require('path');

// Roots that make sense for the oculus work this harness drives. Override with
// SANDBOX_ROOTS. These are the ONLY defaults baked in.
const OCULUS_RELEVANT_ROOTS = [
    path.join(PATHS.workspaceRoot(), 'oculus'),
    PATHS.auditsPlans(),
];

function parseList(raw) {
    if (!raw) return [];
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function resolveRoots(raw) {
    const roots = parseList(raw).length ? parseList(raw) : OCULUS_RELEVANT_ROOTS;
    // Normalise: realpath when it exists (so a symlinked root still matches),
    // otherwise the absolute path.
    return roots.map((r) => {
        const abs = path.resolve(r);
        try {
            return fs.realpathSync(abs);
        } catch {
            return abs;
        }
    });
}

const ENABLED = String(process.env.SANDBOX_ENABLED ?? 'true') !== 'false';
const ALLOW_BASH = String(process.env.SANDBOX_ALLOW_BASH ?? 'false') === 'true';
const LOG = String(process.env.SANDBOX_LOG ?? 'true') !== 'false';
const ROOTS = resolveRoots(process.env.SANDBOX_ROOTS);

function logDenial(kind, value, why) {
    if (!LOG) return;
    try {
        console.error(`[sandbox] DENIED ${kind} ${JSON.stringify(value)} — ${why}`);
    } catch {
        /* logging must never throw */
    }
}

// Resolve a path to something comparable even when the leaf does not exist yet
// (write_file creates files). Walk up to the nearest existing ancestor, realpath
// that, then re-attach the remaining segments.
function realpathAllowingMissing(abs) {
    let dir = path.dirname(abs);
    const tail = [path.basename(abs)];
    for (let i = 0; i < 64; i++) {
        try {
            const real = fs.realpathSync(dir);
            return path.join(real, ...tail.reverse());
        } catch {
            const parent = path.dirname(dir);
            if (parent === dir) break; // hit the filesystem root
            tail.push(path.basename(dir));
            dir = parent;
        }
    }
    return abs;
}

function isInside(candidate, root) {
    if (candidate === root) return true;
    return candidate.startsWith(root + path.sep);
}

// Returns { ok: true, path } or { ok: false, error, path, roots }.
function checkPath(p) {
    if (!ENABLED) return { ok: true, path: p };
    if (typeof p !== 'string' || !p.trim()) {
        return { ok: false, error: 'sandbox: empty path', roots: ROOTS };
    }
    const abs = path.resolve(p);
    const real = realpathAllowingMissing(abs);
    if (ROOTS.some((root) => isInside(real, root))) return { ok: true, path: abs };
    logDenial('path', p, `resolves to ${real}, outside ${JSON.stringify(ROOTS)}`);
    return {
        ok: false,
        path: abs,
        resolved: real,
        roots: ROOTS,
        error:
            `sandbox: path ${p} is outside the allowed roots. ` +
            `Allowed: ${ROOTS.join(', ')}. ` +
            `Add a root with SANDBOX_ROOTS=/path/one,/path/two (then restart the gateway).`,
    };
}

// Bash is not jailed — extract the path-like tokens and refuse the command when
// any of them resolves outside the roots. A command with no path tokens (e.g.
// `git status`) passes when SANDBOX_ALLOW_BASH is on.
const PATH_TOKEN = /(?:^|[\s"'`=(|;&<>])((?:~|\.{0,2}\/|\/)[^\s"'`|;&<>)]*)/g;

function checkCommand(cmd) {
    if (!ENABLED) return { ok: true };
    if (!ALLOW_BASH) {
        logDenial('command', cmd, 'SANDBOX_ALLOW_BASH is not true');
        return {
            ok: false,
            error:
                'sandbox: run_bash is blocked. Set SANDBOX_ALLOW_BASH=true (and BASH_ALLOWED=true) ' +
                'to permit sandboxed shell commands.',
        };
    }
    const offenders = [];
    let m;
    PATH_TOKEN.lastIndex = 0;
    while ((m = PATH_TOKEN.exec(String(cmd))) !== null) {
        let tok = m[1];
        if (!tok || tok.startsWith('-')) continue; // flags are not paths
        if (tok.startsWith('~')) tok = tok.replace(/^~/, process.env.HOME || '');
        // Strip a trailing redirect/quote noise already excluded by the class.
        const abs = path.resolve(tok);
        const real = realpathAllowingMissing(abs);
        if (!ROOTS.some((root) => isInside(real, root))) offenders.push(tok);
    }
    if (offenders.length) {
        logDenial('command', cmd, `path token(s) outside roots: ${JSON.stringify(offenders)}`);
        return {
            ok: false,
            error:
                `sandbox: command touches path(s) outside the allowed roots: ${offenders.join(', ')}. ` +
                `Allowed: ${ROOTS.join(', ')}.`,
        };
    }
    return { ok: true };
}

// Convenience for tool handlers: throws nothing, returns a tool-result object or null.
function denyResult(check) {
    if (check.ok) return null;
    return { success: false, error: check.error, sandbox: true };
}

module.exports = {
    enabled: ENABLED,
    allowBash: ALLOW_BASH,
    roots: ROOTS,
    checkPath,
    checkCommand,
    denyResult,
    // exposed for tests
    _internal: { realpathAllowingMissing, isInside, resolveRoots },
};
