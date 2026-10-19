const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

// 08-17 EXECUTION-LANE CWD FIX (plan-execution root cause): the OCULUS
// executor verifies/commits from the git root (/home/roni/Roni_Workspace/oculus)
// but the webchat expert's relative file/bash ops resolved against the server
// cwd (repo root) — so expert code landed ONE level above where verification
// ran (fake-passes + HALTs, steps 490/491). Webchat lanes launched with
// GIT_ROOT=<git-root> get git-root resolution; other lanes (audit/gemini, no
// GIT_ROOT) keep verbatim path behavior.
const GIT_ROOT = process.env.GIT_ROOT || '';

// 08-19 USER-SESSION SCOPING (root-cause fix: "wtf is going on" — the gemini
// user session kept running oculus-harness actions instead of the user's
// helpotron plan). User-mode gateways (ALLOW_PLAIN_TEXT=true, e.g. PORT=8085)
// serve a NEUTRAL toolset: no oculus-category tools (audit_status, send_message_
// to_main) and git_status defaults to the USER's repo (helpotron), not oculus.
// Autonomous/executor lanes (no ALLOW_PLAIN_TEXT) keep the full harness toolset.
const USER_MODE = process.env.ALLOW_PLAIN_TEXT === 'true';
const DEFAULT_GIT_REPO = USER_MODE ? 'helpotron' : 'oculus';
// 08-19 USER-SESSION CWD (the gemini session listed the webchat-api dir and
// got lost instead of executing the helpotron plan): user-mode tools resolve
// relative paths + run_bash cwd against the USER's workspace, not the server's
// cwd (webchat-api). Absolute paths stay verbatim.
const USER_WORKSPACE = '/home/roni/Roni_Workspace/helpotron';

// 08-20 (audit BUG-04/CRIT-02): path-traversal hardening. Relative paths
// must resolve INSIDE the workspace root (`../../etc/passwd` style escapes
// are refused). Absolute paths stay verbatim — the harness legitimately
// reads audits_plans/state files — but sensitive system dirs (secrets,
// credentials, kernel internals) are off-limits for the webchat.
const SENSITIVE_ABS_PREFIXES = [
    '/etc/', '/root/', '/home/roni/.ssh', '/home/roni/.claude/',
    '/proc/', '/sys/', '/dev/', '/boot/', '/run/', '/var/lib/', '/var/cache/',
];
// 09-04 LANE FIX: shannon's pi agents run in a container where the scan
// target is /repos/<repo> and the scan workspace's .shannon dir is overlaid
// there (/repos/<repo>/.shannon = the workspace .shannon). The lane harness
// executes tools on the HOST, so translate those container paths:
//   GIT_ROOT        = host repo root (also the tools' default root)
//   WS_SHANNON_DIR  = host path of the workspace .shannon (the overlay target)
const WS_SHANNON_DIR = process.env.WS_SHANNON_DIR || '';
function translatePath(abs) {
    if (!GIT_ROOT) return null;
    const prefix = '/repos/' + path.basename(GIT_ROOT);
    if (!abs.startsWith(prefix)) return null;
    const rest = abs.slice(prefix.length);
    if (WS_SHANNON_DIR && (rest === '/.shannon' || rest.startsWith('/.shannon/'))) {
        return path.join(WS_SHANNON_DIR, rest.slice('/.shannon/'.length));
    }
    return abs === prefix ? GIT_ROOT : path.join(GIT_ROOT, rest);
}
function resolvePath(p) {
    if (typeof p !== 'string' || p === '') return p;
    const root = path.resolve(USER_MODE ? USER_WORKSPACE : (GIT_ROOT || process.cwd()));
    let abs = path.isAbsolute(p) ? p : path.resolve(root, p);
    // 09-04: track remaps; a path translated into WS_SHANNON_DIR (the scan
    // workspace overlay) is trusted — the escape check below must NOT re-measure
    // it against GIT_ROOT, which would reject every `.shannon/...` read.
    let remapped = false;
    if (path.isAbsolute(p)) {
        const t = translatePath(abs);
        if (t) { abs = t; remapped = true; }
    } else if (WS_SHANNON_DIR) {
        const rel = path.relative(root, abs);
        if (rel === '.shannon' || rel.startsWith('.shannon/')) {
            abs = path.join(WS_SHANNON_DIR, rel === '.shannon' ? '' : rel.slice('.shannon/'.length));
            remapped = true;
        }
    }
    if (!remapped && !path.isAbsolute(p)) {
        const rel = path.relative(root, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Access Denied: path escapes the workspace root: ${p}`);
        }
    }
    if (SENSITIVE_ABS_PREFIXES.some((s) => abs.startsWith(s))) {
        throw new Error(`Access Denied: sensitive path outside the workspace: ${p}`);
    }
    return abs;
}
// Rewrite the expert's learned "cd /home/roni/Roni_Workspace" (repo root) to
// the git root. "cd .../oculus" is left untouched.
function gitRootCd(cmd) {
    if (!GIT_ROOT) return cmd;
    return String(cmd).replace(/(^|[\s;&|]+)cd\s+\/home\/roni\/Roni[_Ww]orkspace(?![./\w-])/g, `$1cd ${GIT_ROOT}`);
}

// 08-14 WEDGE ROOT-CAUSE ceiling: tool RESULTS must never round-trip a huge
// file through the chat tab (read_file on a 5.86MB state file → 6.2M-char
// prompt → tab choked, gateway wedged). See read_file handler.
const MAX_READ_FILE_CHARS = parseInt(process.env.MAX_READ_FILE_CHARS || '200000', 10);

// Small read-only command runner (git_status). Captures stdout/stderr with a
// hard timeout — never used for interactive or long-running commands.
function runCmd(argv, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 20000) child.kill(); });
        child.stderr.on('data', (d) => { stderr += d; });
        const t = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ success: false, stdout, stderr: stderr + '\n[timed out]' });
        }, timeoutMs);
        child.on('error', (e) => { clearTimeout(t); resolve({ success: false, stdout, stderr: e.message }); });
        child.on('close', (code) => { clearTimeout(t); resolve({ success: code === 0, stdout, stderr }); });
    });
}

// ──────────────────────────────────────────────────────
// SECURITY: run_bash whitelist + secret redaction
// ──────────────────────────────────────────────────────
// 08-20 (audit BUG-03/CRIT-02): shell-injection hardening for run_bash.
// The old deny-list alone was bypassable (`pyt""est; evil`, `curl | bash`).
// Now every compound-command segment's first binary must be allowlisted,
// bare pipes and code-exec flags are refused, and plan/state files are
// write-protected. The executor's own verification commands run through
// Python's run_isolated_shell_command (NOT this path), so this can be strict
// without breaking the pipeline.
const ALLOWED_BINARIES = new Set([
    'cd', 'python3', 'python', 'pytest', 'pip', 'pip3', 'uv', 'git', 'gh',
    'ls', 'cat', 'grep', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq',
    'cut', 'tr', 'find', 'diff', 'tee', 'basename', 'dirname', 'date', 'stat',
    'mkdir', 'rm', 'cp', 'mv', 'touch', 'chmod', 'ln', 'rmdir',
    'echo', 'printf', 'true', 'false', 'test', '[', 'sleep', 'timeout',
    'curl', 'wget', 'nohup', 'bash', 'sh', 'env', 'export', 'source',
    'ps', 'df', 'du', 'free', 'jq', 'xargs',
    // 08-20: lint/type-check verification tools used by the master plan
    // (executor parser normalizes mypy --strict -> --follow-imports=skip).
    // These inspect source; they do not execute it (mypy -c type-checks only).
    'mypy', 'ruff', 'black',
    // 08-20 (step 829 + ~30 flutter steps): flutter/dart verification commands.
    // /home/roni/bin/flutter is a CI simulation stub on this box (exit 0 for
    // analyze/test), so these checks are deterministic.
    'flutter', 'dart',
]);
// Code-exec flags that would nullify the whitelist (arbitrary code from a
// whitelisted interpreter): python3 -c, bash -c/-s, node -e/-p, perl -e...
const CODE_EXEC_FLAGS = new Set(['-c', '-e', '-p', '-r', '-s']);
const CODE_EXEC_BINARIES = new Set(['python3', 'python', 'bash', 'sh', 'node', 'perl', 'ruby', 'php']);
// 08-20 (audit BUG-08 surface): the webchat must never rewrite the master
// plan or execution-state files (integrity of the whole pipeline).
const PROTECTED_ARTIFACT_RE = /(?:master_plan|execution_state|helotron_execution_state|audit_state|workflow_state|cross_eval_state)[.\w-]*\.(json|md)/i;

function assertCommandSafe(cmdStr) {
    // Returns null when safe, else an error string.
    const cmd = String(cmdStr || '').trim();
    if (!cmd) return 'empty command';
    // Hard bans: command substitution / backticks / bare pipes. (`||` stays —
    // each side is independently whitelisted below.)
    if (/\$\(/.test(cmd)) return 'command substitution $() is forbidden';
    if (/`/.test(cmd)) return 'backticks are forbidden';
    if (/(?<!\|)\|(?!\|)/.test(cmd)) return 'bare pipe chains are forbidden (use >> /tmp/out.txt + read_file to page output)';
    // Protected artifacts: any redirect/tee into the plan or state files.
    if (/(?:>|tee\s+)[^;\n]*(?:master_plan|_state\.json)/i.test(cmd)) {
        return 'writing to the master plan / execution state is forbidden';
    }
    const segments = cmd.split(/;|\n|\r|&&|\|\|/);
    for (let seg of segments) {
        seg = seg.trim();
        if (!seg) continue;
        // Strip env-assignment prefixes (FOO=bar cmd) — harmless once the
        // command itself is whitelisted.
        let toks = seg.split(/\s+/).filter(Boolean);
        while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
        if (!toks.length) continue;
        const bin = toks[0];
        if (!ALLOWED_BINARIES.has(bin)) {
            return `forbidden binary: ${bin} (allowed: ${[...ALLOWED_BINARIES].sort().join(', ')})`;
        }
        if (CODE_EXEC_BINARIES.has(bin) && toks.slice(1).some((t) => CODE_EXEC_FLAGS.has(t))) {
            const flag = toks.slice(1).find((t) => CODE_EXEC_FLAGS.has(t));
            return `code-exec flag ${flag} is forbidden on ${bin} (use a script file instead)`;
        }
        if (bin === 'find') {
            const m = seg.match(/-exec\s+([^\s;]+)/);
            if (m && !ALLOWED_BINARIES.has(m[1])) {
                return `find -exec target not whitelisted: ${m[1]}`;
            }
        }
    }
    return null;
}

// 08-20 (audit SEC-05): secrets that round-trip through run_bash (a model
// echoing a token, cat'ing a file with one) must never reach the bash_tool
// log or the model's context in cleartext.
const SECRET_REDACT_RE = /(ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AAG[A-Za-z0-9_-]{25,}|Bearer\s+[A-Za-z0-9._-]{16,})/g;
function redactSecrets(s) {
    if (typeof s !== 'string') return s;
    return s.replace(SECRET_REDACT_RE, '[REDACTED]');
}

// ──────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ──────────────────────────────────────────────────────
const TOOL_DEFINITIONS = [
    {
        name: 'read_file',
        category: 'file',
        description: 'Read contents of a file. Hard ceiling: results are ALWAYS capped at 200K chars (truncated:true + totalLength), so a huge file can never balloon the chat — pass maxLength to control the window read and offset to page through the rest.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to read' },
                // Optional head-only read: keeps big files (34KB App.jsx) from
                // ballooning the thread when only the top matters (08-12 context-
                // overflow spiral). Re-read WITHOUT maxLength before rewriting a
                // file so the rewrite never starts from a partial view.
                maxLength: { type: 'integer', description: 'Optional — read only the first N characters; the result flags truncation' },
                // 08-19 (user): paging. A truncated result tells the agent the
                // file is bigger than the window; the agent calls read_file
                // again with offset=<chars shown so far> (+ maxLength) to see
                // the next window instead of re-reading the head forever.
                offset: { type: 'integer', description: 'Optional — start reading at this character index (pairs with maxLength to page through a large file); truncated:true stays set while more content remains after this window' },
            },
            required: ['path'],
        },
        handler: async (args) => {
            const resolved = resolvePath(args.path);
            const content = fs.readFileSync(resolved, 'utf-8');
            // 08-14 WEDGE ROOT-CAUSE: read_file without maxLength returned the
            // FULL file (5.86MB cross_eval_state.json) into the tool-result
            // message → next prompt = 6,197,724 chars → the webchat tab choked
            // and the gateway wedged on "Waiting for response..." for hours.
            // Hard ceiling regardless of args: a file this big must NEVER
            // round-trip through the tab, and explicit maxLength is clamped too.
            const limit = Math.min(args.maxLength || MAX_READ_FILE_CHARS, MAX_READ_FILE_CHARS);
            // 08-19 (user): offset paging. The window is [offset, offset+limit);
            // truncated:true only while MORE content remains after it, so the
            // final window reads clean (truncated:false) and the agent knows
            // it has the whole file.
            const offset = Math.max(0, Math.min(args.offset || 0, Math.max(content.length - 1, 0)));
            if (content.length > limit || offset > 0) {
                const end = Math.min(offset + limit, content.length);
                return {
                    success: true,
                    truncated: end < content.length,
                    totalLength: content.length,
                    offset,
                    content: content.slice(offset, end),
                };
            }
            return { success: true, content };
        },
    },
    {
        name: 'write_file',
        category: 'file',
        description: 'Write content to a file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to write to' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
        },
        handler: async (args) => {
            const resolved = resolvePath(args.path);
            let oldContent = null;
            try {
                oldContent = fs.readFileSync(resolved, 'utf-8');
            } catch (e) {
                oldContent = null; // new file — no diff against anything
            }
            fs.writeFileSync(resolved, args.content, 'utf-8');
            return {
                success: true,
                message: `Written to ${resolved}`,
                oldContent,
                newLength: String(args.content ?? '').length,
            };
        },
    },
    {
        // SECURITY: disabled unless BASH_ALLOWED=true. The webchat model's
        // output is executed verbatim here — a prompt-injected or hostile
        // response could run anything on this machine.
        name: 'run_bash',
        category: 'system',
        description: 'Run a bash command on this machine (disabled unless BASH_ALLOWED=true).',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Bash command to execute' },
            },
            required: ['command'],
        },
        handler: (args) =>
            new Promise((resolve) => {
                if (!config.bashAllowed) {
                    return resolve({
                        success: false,
                        error:
                            'run_bash is disabled. Set BASH_ALLOWED=true in .env to enable ' +
                            '(it executes webchat-model-controlled strings — read the README warning).',
                    });
                }
                const origCmd = String(args.command || "");
                const cmd = gitRootCd(origCmd);
                // 08-14 DENY-BY-DEFAULT guard (owner directive): hard-block
                // dangerous patterns even when BASH_ALLOWED=true. git push is
                // allowed ONLY to feature branches (explicit branch check).
                const DANGER = [
                    "pkill -f",
                    "node -e",
                    "node -p",
                    "rm -rf",
                    "settings_backup.json",
                    "ghp_",
                    "TELEGRAM_TOKEN",
                    "BOT_TOKEN",
                ];
                let denied = null;
                for (const s of DANGER) {
