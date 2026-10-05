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
const PATHS = require('../core/paths');
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

// 09-22: the config file is the MASTER config and it already carries
// features.sandbox / features.sandboxAllowBash / network.sandboxRoots — but this
// module read the environment only, so setting them there was an INERT CONTROL:
// the runbook said bash was permitted, the config agreed, and every run_bash was
// still refused. Prefer config, fall back to env, keep the safe defaults.
const _cfg = (() => { try { return require('../core/config'); } catch { return null; } })();
const _cfgSandbox = (_cfg && _cfg.sandbox) || {};
const _envBool = (name, dflt) => (process.env[name] === undefined ? dflt : String(process.env[name]) !== 'false');
const ENABLED = _cfgSandbox.enabled !== undefined
    ? !!_cfgSandbox.enabled
    : _envBool('SANDBOX_ENABLED', true);
const ALLOW_BASH = (_cfgSandbox.allowBash === true) || String(process.env.SANDBOX_ALLOW_BASH ?? 'false') === 'true';
const LOG = _cfgSandbox.log !== undefined
    ? !!_cfgSandbox.log
    : _envBool('SANDBOX_LOG', true);
const ROOTS = (_cfgSandbox.roots && _cfgSandbox.roots.length)
    ? resolveRoots(_cfgSandbox.roots.join(','))
    : resolveRoots(process.env.SANDBOX_ROOTS);

function logDenial(kind, value, why) {
    if (!LOG) return;
    try {
        console.error(`[sandbox] DENIED ${kind} ${JSON.stringify(value)} — ${why}`);
    } catch {
        /* logging must never throw */
    }
}

// Resolve `abs` to the location it will actually be read from or written to, following
// a symlink at EVERY component — including the leaf.
//
// MEASURED 2026-10-05: the previous version realpath'd only `path.dirname(abs)` and
// re-attached `basename(abs)` untouched, so a symlink AT THE LEAF was never resolved.
// With SANDBOX_ROOTS=<base>/root and `<root>/link.txt -> ../outside/secret.txt`,
// checkPath returned ok:true and read_file returned the contents of a file outside the
// root; writing through the same link created the file outside the root. Every symlinked
// DIRECTORY component was resolved correctly (that case was already denied), which is
// what made the hole easy to miss: the header's promise that "symlinks pointing outside
// a root are both rejected" held for every shape except the file name itself.
//
// The walk is component by component from the filesystem root:
//   - a component that does not exist ends the walk — nothing below it can be a link,
//     and the rest of the path is re-attached verbatim (write_file's normal case);
//   - a component that IS a link is replaced by its target and the walk restarts, so a
//     chain (a -> b -> ../outside) and a DANGLING leaf (new.txt -> ../outside/new.txt,
//     whose target does not exist yet — exactly what a write creates) both resolve to
//     where the write lands;
//   - a link loop, or more hops than MAX_HOPS, returns null, and null is treated as
//     outside the roots. "Could not resolve it" must never read as "it is inside".
function realpathAllowingMissing(abs) {
    const MAX_HOPS = 64;
    let queue = path.resolve(abs).split(path.sep).filter(Boolean);
    const out = []; // the symlink-free prefix resolved so far
    for (let hop = 0; hop < MAX_HOPS; hop++) {
        while (queue.length && queue[0] === '.') queue.shift(); // `./` in a link target
        if (!queue.length) return path.sep + out.join(path.sep);
        // `..` must be CONSUMED, not pushed into `out`. Measured 2026-10-05: without
        // this, a link target of `../outside/secret.txt` left the walk holding
        // `.../root/../outside/secret.txt`, which still STARTS WITH the root string, so
        // isInside() said the path was inside and the guard waved it through. Popping
        // `out` collapses the traversal to where the write actually lands.
        if (queue[0] === '..') {
            queue.shift();
            if (out.length) out.pop();   // a `..` above the filesystem root is a no-op
            continue;
        }
        const next = path.sep + out.concat(queue[0]).join(path.sep);
        let st = null;
        try {
            st = fs.lstatSync(next);
        } catch {
            st = null; // ENOENT (or EACCES): the remaining components do not exist either
        }
        if (st && st.isSymbolicLink()) {
            let target;
            try {
                target = fs.readlinkSync(next);
            } catch {
                return null;
            }
            // `out` already IS the symlink-free parent of `next`, so a relative target
            // keeps it; an absolute target restarts the walk from the filesystem root.
            if (path.isAbsolute(target)) out.length = 0;
            queue = target.split(path.sep).filter(Boolean).concat(queue.slice(1));
            continue;
        }
        if (!st) {
            const tail = queue.slice(1);
            return tail.length ? next + path.sep + tail.join(path.sep) : next;
        }
        out.push(queue.shift());
    }
    return null;
}

function isInside(candidate, root) {
    // A path we could not resolve (null) is inside nothing. Fail closed.
    if (typeof candidate !== 'string' || typeof root !== 'string' || !candidate) return false;
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

// Device files and process-substitution sinks are not "paths outside the roots"
// — they are pipes to the kernel that every shell command is entitled to use.
// Measured 2026-09-23: `... 2>/dev/null` was DENIED with
// "path token(s) outside roots: [\"/dev/null\"]", so a legitimate command the
// runbook explicitly permits was refused for redirecting its own stderr. The
// check exists to stop a command reaching a file it should not, and there is
// nothing to reach in /dev/null.
const SAFE_PATH_TOKENS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero']);

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
        if (SAFE_PATH_TOKENS.has(tok)) continue;   // kernel sinks, not files
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
