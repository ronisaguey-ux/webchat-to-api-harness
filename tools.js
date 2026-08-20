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
function resolvePath(p) {
    if (typeof p !== 'string' || p === '') return p;
    const root = path.resolve(USER_MODE ? USER_WORKSPACE : (GIT_ROOT || process.cwd()));
    const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
    if (!path.isAbsolute(p)) {
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
                    if (cmd.includes(s)) { denied = s; break; }
                }
                if (denied) {
                    return resolve({
                        success: false,
                        error: "run_bash DENIED: command matches dangerous pattern: " + denied,
                    });
                }
                // 08-20 (audit BUG-03/CRIT-02): per-segment binary whitelist —
                // the deny-list above alone was bypassable. See assertCommandSafe.
                const segErr = assertCommandSafe(cmd);
                if (segErr) {
                    return resolve({
                        success: false,
                        error: "run_bash DENIED: " + segErr,
                    });
                }
                const toks = cmd.split(" ").filter(Boolean);
                const gi = toks.indexOf("git");
                const pi = toks.indexOf("push");
                if (gi !== -1 && pi !== -1 && pi > gi) {
                    const rest = toks.slice(pi + 1);
                    const branch = rest.filter((t) => t[0] !== "-" && t !== "origin" && t !== "upstream").pop();
                    if (!branch || branch === "master" || branch === "main") {
                        return resolve({
                            success: false,
                            error: "run_bash DENIED: git push requires an explicit feature branch (master/main forbidden)",
                        });
                    }
                }
                // Log EVERY executed command (denied ones are NOT executed).
                try {
                    fs.appendFileSync(
                        "/home/roni/Roni_Workspace/webchat-api/bash_tool_log.jsonl",
                        JSON.stringify({ ts: new Date().toISOString(), cmd: redactSecrets(origCmd), executed: redactSecrets(cmd), gitRoot: GIT_ROOT }) + os.EOL
                    );
                } catch (e) { /* logging must never block execution */ }
// spawn + stdio→temp files instead of execFile + pipes: execFile
                // waits for the pipes to CLOSE, so `cmd &` (backgrounded servers)
                // blocked until the timeout — the model's "uvicorn ... &" hung
                // every request a full 60s (2nd session 08-12). bash -c exits
                // immediately after backgrounding; 'exit' fires, we resolve, and
                // the background child survives (detached) writing to the files.
                // On timeout, kill(-pid) takes the whole process group — the old
                // code killed only bash and orphaned the foreground child.
                const outFile = `${os.tmpdir()}/webchat_exec_${process.pid}_${Date.now()}.out`;
                const errFile = outFile.replace(/\.out$/, '.err');
                const outFd = fs.openSync(outFile, 'w');
                const errFd = fs.openSync(errFile, 'w');
                // 08-13 EVENING: stdin instead of `-c` — `bash -c "<cmd>"` puts
                // the command text in the wrapper's own cmdline, so a pkill -f
                // inside the command (e.g. "pkill -f uvicorn") matched the
                // wrapper itself and SIGTERM'd it → "exit code null" tool
                // failures. With `bash -s` the wrapper cmdline is just "bash",
                // so pkill only matches the real target processes.
                const child = spawn('/bin/bash', ['-s'], {
                    detached: true,
                    stdio: ['pipe', outFd, errFd],
                    ...(GIT_ROOT ? { cwd: GIT_ROOT } : USER_MODE ? { cwd: USER_WORKSPACE } : {}),
                });
                child.stdin.write(cmd);
                child.stdin.end();
                let settled = false;
                const finish = (extra) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    try { fs.closeSync(outFd); } catch (e) { /* already closed */ }
                    try { fs.closeSync(errFd); } catch (e) { /* already closed */ }
                    let stdout = '';
                    let stderr = '';
                    try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) { /* gone */ }
                    try { stderr = fs.readFileSync(errFile, 'utf8'); } catch (e) { /* gone */ }
                    // Orphans may keep appending — read the tail, then unlink so
                    // the files can't grow unbounded.
                    if (stdout.length > config.execMaxBuffer) stdout = stdout.slice(-config.execMaxBuffer);
                    if (stderr.length > config.execMaxBuffer) stderr = stderr.slice(-config.execMaxBuffer);
                    try { fs.unlinkSync(outFile); } catch (e) { /* already gone */ }
                    try { fs.unlinkSync(errFile); } catch (e) { /* already gone */ }
                    // 08-20 (audit SEC-05): strip secrets before the model sees output.
                    stdout = redactSecrets(stdout);
                    stderr = redactSecrets(stderr);
                    resolve({ success: true, ...extra, stdout, stderr: stderr || '' });
                };
                child.on('error', (err) => finish({ success: false, error: err.message }));
                child.on('exit', (code) =>
                    finish(code === 0 ? {} : { success: false, error: `exit code ${code}` }));
                const timer = setTimeout(() => {
                    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
                    finish({ success: false, error: `timed out after ${Math.round(config.execTimeoutMs / 1000)}s` });
                }, config.execTimeoutMs);
            }),
    },
    {
        name: 'list_dir',
        category: 'file',
        description: 'List contents of a directory.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path' },
            },
            required: ['path'],
        },
        handler: async (args) => {
            const files = fs.readdirSync(resolvePath(args.path));
            return { success: true, files };
        },
    },
    {
        // 2026-08-13: replaced the simulated placeholder with REAL search —
        // DeepSeek's Anthropic-compatible endpoint (api.deepseek.com/v1/messages,
        // x-api-key auth) with the native web_search_20250305 tool, which does
        // server-side search + decryption and returns result entries + an AI
        // answer with sources. Requires DEEPSEEK_API_KEY in the gateway .env
        // (same key the websearch-deepseek MCP uses — v4 flash only, never
        // deepseek-chat).
        name: 'search_web',
        category: 'web',
        description: 'Search the web; returns result entries plus an AI-written answer with source URLs.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
        },
        handler: async (args) => {
            const key = process.env.DEEPSEEK_API_KEY;
            if (!key) {
                return { success: false, error: 'search disabled: DEEPSEEK_API_KEY not set in the gateway .env' };
            }
            const body = {
                model: 'deepseek-v4-flash',
                max_tokens: 1000,
                messages: [
                    {
                        role: 'system',
                        content: 'Search the web for the query, then give a final answer in the same language the user used, with source URLs. Use the web_search tool exactly once.',
                    },
                    { role: 'user', content: String(args.query || '') },
                ],
                tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                tool_choice: { type: 'auto' },
            };
            try {
                const resp = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-api-key': key },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(45000),
                });
                if (!resp.ok) {
                    const t = await resp.text().catch(() => '');
                    return { success: false, error: `search API ${resp.status}: ${t.slice(0, 200)}` };
                }
                const data = await resp.json();
                const results = [];
                const textParts = [];
                for (const block of (data.content || [])) {
                    if (block.type === 'web_search_tool_result' && block.content) {
                        for (const item of block.content) {
                            results.push({
                                title: item.title || '',
                                url: item.url || '',
                                text: (item.text || '').slice(0, 300),
                            });
                        }
                    } else if (block.type === 'text' && block.text) {
                        textParts.push(block.text);
                    }
                }
                return {
                    success: true,
                    answer: textParts.join('\n').slice(0, 3000),
                    results: results.slice(0, 8),
                    resultCount: results.length,
                };
            } catch (e) {
                return { success: false, error: String((e && e.message) || e) };
            }
        },
    },
    {
        // 2026-08-13: a real clock — the webchat must never guess the date
        // (the stale-date mistake class). Always use this for "what time is it".
        name: 'get_time',
        category: 'system',
        description: 'Get the current date and time. NEVER guess the current date from memory — call this.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
        handler: async () => {
            const now = new Date();
            return {
                success: true,
                iso: now.toISOString(),
                local: now.toString(),
                epochMs: now.getTime(),
            };
        },
    },
    {
        // 08-13 EVENING (user rule): the ONLY way to talk to the user in
        // JSON-only mode. server.js special-cases this name before executeTool
        // and delivers the text to the client as a 'text' progress event
        // (rendered "💬 <text>"). This handler is the fallback shape for
        // paths that don't special-case it (runHandoff).
        name: 'send_message',
        category: 'chat',
        description:
            'Send a plain-text message to the user (delivered verbatim, rendered as "💬 <text>"). ' +
            'Use this to acknowledge the user\'s message, narrate what you are about to do before ' +
            'every other tool call, and to send your final summary. This is the ONLY way to ' +
            'communicate in plain text.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'The message text (one short line — what you are thinking and about to do)' },
            },
            required: ['text'],
        },
        handler: async (args) => {
            const text = String(args?.text ?? '');
            if (!text) return { success: false, error: 'empty message' };
            return { success: true, delivered: true, text };
        },
    },
    {
        // 2026-08-13: the webchat can answer "how's the pipeline / when does
        // the audit finish" itself — same data the main session reads.
        name: 'audit_status',
        category: 'oculus',
        description: 'Get the Oculus pipeline status: cycle, phase, running/paused, and audit pass/batch progress.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
        handler: async () => {
            const read = (p) => {
                try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
            };
            const wf = read('/home/roni/Roni_Workspace/audits_plans/workflow_state.json');
            const ad = read('/home/roni/Roni_Workspace/audits_plans/audit_state.json');
            return {
                success: true,
                cycle: (wf && wf.cycle) ?? null,
                phase: (wf && wf.phase) ?? null,
                running: (wf && wf.running) ?? null,
                paused: (wf && wf.paused) ?? null,
                audit: ad ? {
                    pass: ad.current_pass,
                    numPasses: ad.num_passes ?? null,
                    batchesDone: (ad.current_pass_completed_batches || []).length,
                    totalBatches: ad.total_batches ?? null,
                    completedPasses: ad.completed_passes || [],
                    // 08-14: the runner's final state write bumps current_pass to
                    // num_passes+1 (by design) — flag completion so readouts stop
                    // showing a scary "pass 6/5, 0 batches".
                    allPassesComplete: (ad.completed_passes || []).length >= (ad.num_passes || 0),
                } : null,
            };
        },
    },
    {
        // 2026-08-13: read-only repo state for the workspace repos.
        name: 'git_status',
        category: 'git',
        description: 'Read-only git status (branch, short status, last 3 commits) of a workspace repo.',
        parameters: {
            type: 'object',
            properties: {
                repo: {
                    type: 'string',
                    description: `Repo: ${DEFAULT_GIT_REPO} (default), webchat-api, or ${DEFAULT_GIT_REPO === 'oculus' ? 'helpotron' : 'oculus'}`,
                },
            },
            required: [],
        },
        handler: async (args) => {
            const repos = {
                oculus: '/home/roni/Roni_Workspace/oculus',
                'webchat-api': '/home/roni/Roni_Workspace/webchat-api',
                helpotron: '/home/roni/Roni_Workspace/helpotron',
            };
            const dir = repos[String((args && args.repo) || DEFAULT_GIT_REPO)];
            if (!dir) {
                return { success: false, error: `unknown repo; use one of: ${Object.keys(repos).join(', ')}` };
            }
            const st = await runCmd(['git', '-C', dir, 'status', '--short', '--branch']);
            const lg = await runCmd(['git', '-C', dir, 'log', '--oneline', '-3']);
            return {
                success: st.success,
                branchStatus: st.stdout,
                recentCommits: lg.stdout,
            };
        },
    },
    {
        // 2026-08-13: the webchat can message the owner directly — appends to
        // the same outbox the orchestrator relay delivers. "webchat: " prefix
        // enforced per the user's 08-13 contract.
        name: 'telegram_send',
        category: 'telegram',
        description: 'Send a Telegram message to the owner (delivered via the outbox relay; "webchat: " prefix auto-added).',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Message text' },
            },
            required: ['text'],
        },
        handler: async (args) => {
            const OUTBOX = '/home/roni/Roni_Workspace/audits_plans/claude_outbox.json';
            let text = String((args && args.text) || '').trim();
            if (!text) return { success: false, error: 'empty text' };
            if (!/^webchat: /i.test(text)) text = 'webchat: ' + text;
            let out = [];
            try { out = JSON.parse(fs.readFileSync(OUTBOX, 'utf-8')); } catch { out = []; }
            if (!Array.isArray(out)) out = [];
            out.push({ ts: new Date().toISOString(), from: 'claude', text });
            const tmp = OUTBOX + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
            fs.renameSync(tmp, OUTBOX);
            return { success: true, message: 'queued for Telegram delivery' };
        },
    },
    {
        // 2026-08-14 (user): the webchat's tool channel to the MAIN session.
        // Appends to the same inbox the responder's FORWARD_TO_MAIN writes;
        // a monitor wakes the main session. MAIN replies into
        // claude_webchat_outbox.json with "to": <thread URL> and the gateway
        // injects them into the thread's next message.
        name: 'send_message_to_main',
        category: 'oculus',
        description:
            'Send a message to the MAIN Claude session (backup operator/fixer). Use when you need ' +
            'something beyond your tools: real file access, system decisions, or escalation. ' +
            'The main session wakes immediately and its reply is shown to you in your next message.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'The message to main (what you need, what you found)' },
            },
            required: ['text'],
        },
        handler: async (args, ctx) => {
            const INBOX = '/home/roni/Roni_Workspace/audits_plans/claude_webchat_inbox.json';
            const text = String((args && args.text) || '').trim();
            if (!text) return { success: false, error: 'empty text' };
            let out = [];
            try { out = JSON.parse(fs.readFileSync(INBOX, 'utf-8')); } catch { out = []; }
            if (!Array.isArray(out)) out = [];
            const item = { ts: new Date().toISOString(), from: 'webchat', text };
            if (ctx && ctx.threadId) item.thread = ctx.threadId;
            out.push(item);
            const tmp = INBOX + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
            fs.renameSync(tmp, INBOX);
            return { success: true, message: 'Message sent to main; its reply will appear in your next message.' };
        },
    },
    {
        name: 'send_message_to_antigravity',
        category: 'interagent',
        description:
            'Send a structured message or task to Antigravity (AGY). ' +
            'Wakes the Antigravity core immediately.',
        parameters: {
            type: 'object',
            properties: {
                subject: { type: 'string', description: 'Subject of the message' },
                content: { type: 'string', description: 'Body text / instructions for Antigravity' },
                priority: { type: 'string', enum: ['normal', 'high', 'urgent'], description: 'Message priority' },
            },
            required: ['content'],
        },
        handler: async (args) => {
            const INBOX = `${os.homedir()}/.claude/inbox/messages.jsonl`;
            const content = String(args?.content || '').trim();
            if (!content) return { success: false, error: 'empty content' };
            const entry = {
                id: `msg_${Math.floor(Date.now() / 1000)}_${Math.random().toString(16).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                from: 'webchat',
                to: 'antigravity',
                subject: String(args.subject || 'Webchat Directive'),
                priority: String(args.priority || 'normal'),
                content,
                status: 'unread',
                reply_to: null,
            };
            try {
                fs.mkdirSync(`${os.homedir()}/.claude/inbox`, { recursive: true });
                fs.appendFileSync(INBOX, JSON.stringify(entry) + '\n', 'utf-8');
                return { success: true, message: 'Message sent to Antigravity inbox.' };
            } catch (e) {
                return { success: false, error: e.message };
            }
        },
    },
    {
        name: 'send_telegram_message',
        category: 'chat',
        description: 'Send a message directly to the user on Telegram.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text message to send to Telegram user' },
            },
            required: ['text'],
        },
        handler: async (args) => {
            let text = String(args?.text || '').trim();
            if (!text) return { success: false, error: 'empty text' };
            if (!text.toLowerCase().startsWith('webchat:')) {
                text = `webchat: ${text}`;
            }
            // 08-20: corrected telegram_monitor dir (audit SEC-03 surface — the
            // tool silently returned "failed" with the old hyphen path).
            const sendScript = '/home/roni/Roni_workspace/oculus/scripts/telegram_monitor/telegram-monitor/bin/send-telegram.sh';
            const envFile = `${os.homedir()}/.config/oculus/orchestrator.env`;
            const cmd = `set -a; [ -f "${envFile}" ] && source "${envFile}"; set +a; bash "${sendScript}" "${text.replace(/"/g, '\\"')}"`;
            return new Promise((resolve) => {
                const child = spawn('/bin/bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
                child.on('close', (code) => {
                    resolve({ success: code === 0, message: code === 0 ? 'Sent to Telegram.' : 'Failed sending to Telegram.' });
                });
            });
        },
    },
];

// ──────────────────────────────────────────────────────
// TOOL EXECUTOR
// ──────────────────────────────────────────────────────
function getToolDefinitions() {
    // Expose only the schema (name/category/description/parameters), never the handler
    return TOOL_DEFINITIONS
        .filter((t) => !(USER_MODE && t.category === 'oculus'))
        .map(({ handler, ...rest }) => rest);
}

async function executeTool(toolName, args, ctx) {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
    if (!tool) {
        return {
            success: false,
            error: `Tool "${toolName}" not found. Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}`,
        };
    }
    console.log(`🔧 Executing: ${toolName}(${JSON.stringify(args)})`);
    try {
        const result = await tool.handler(args || {}, ctx || {});
        console.log(`✅ Tool ${toolName} executed.`);
        return result;
    } catch (e) {
        console.warn(`⚠️  Tool ${toolName} failed:`, e.message);
        return { success: false, error: e.message };
    }
}

// ──────────────────────────────────────────────────────
// TOOL-CALL PARSER
//    Accepts bare JSON, ```json fences, and prose-wrapped JSON.
//    Extracts EVERY {"tool": "...", "params": {...}} block in order, plus the
//    plain-text prose that precedes the first one (harness protocol 08-13:
//    the model may send a "what I'm about to do" message before its tool call,
//    and the gateway delivers that message before executing the call).
//    Repairs two known DeepSeek renderer/model defects:
//      - a MISSING FINAL BRACE (the renderer truncates the last "}" of a
//        fenced JSON reply — user report 08-13: the raw `jsonCopyDownload
//        {...}` leak),
//      - RAW TRIPLE-QUOTED STRINGS inside the JSON ("content":"""..."""),
//        which the chat model writes for file content instead of JSON escapes.
// ──────────────────────────────────────────────────────
function tryParse(s) {
    try { return JSON.parse(s); } catch { return null; }
}

// Strip the renderer's code-block chrome ("json" label, Copy/Download button
// labels) from text that precedes the JSON envelope. The labels sit BETWEEN
// the intent message and the JSON ("I'll do X. json Copy Download {"tool":..."),
// so they must go from the tail of the prose, not just its head.
function cleanProse(s) {
    if (typeof s !== 'string') return '';
    const chrome = /(?:json|txt|text|python|bash|shell)\s*(?:Copy\s*)?(?:Download\s*)/i;
    return s
        .replace(/Gemini said\s*/gi, '')
        .replace(/^JSON\s*/i, '')
        .replace(/```(?:json)?/gi, '')
        .replace(new RegExp('^\\s*' + chrome.source, 'i'), '')
        .replace(new RegExp(chrome.source + '\\s*$', 'i'), '')
        .replace(/^\s*(?:json|txt|text|python|bash|shell)\s*$/i, '')
        .trim();
}

function parseToolCalls(response) {
    const result = { prose: '', toolCalls: [] };
    if (typeof response !== 'string') return result;

    // 08-12: scan EVERY balanced {...} block, not just the first. The old code
    // pinned `start` at the FIRST '{' — if any prose before the JSON contained
    // a brace ("added {x: 1} to the code"), the candidate spanned prose+JSON,
    // JSON.parse failed, and the scan NEVER advanced: valid tool-call replies
    // were rejected as yaps (the 2-rejections-before-every-call pattern in the
    // 2nd session; the DeepThink reasoning block that used to ride along in the
    // extracted text was exactly such brace-poisoned prose). Cap attempts so a
    // pathological prose-y reply can't turn this into an O(n^2) grind.
    const text = response.replace(/```(?:json)?/gi, '').trim();
    let start = text.indexOf('{');
    let attempts = 0;
    let firstCallStart = -1;
    while (start !== -1 && attempts++ < 16) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') inString = false;
                continue;
            }
            if (c === '"') inString = true;
            else if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }
        let candidate;
        if (end === -1) {
            // 08-13: scan ran off the end of the reply with braces still open
            // — the renderer truncates the LAST brace of a fenced JSON reply
            // ("...work on it."} missing the final }). Repair: close the open
            // string if the cut landed inside one, close the open braces, and
            // attempt a parse. A repaired candidate that still isn't a tool
            // call just fails the parse below; nothing more to try after it.
            let repaired = text.slice(start);
            if (inString) repaired += '"';
            repaired += '}'.repeat(Math.min(depth, 20));
            candidate = repaired;
        } else {
            candidate = text.slice(start, end + 1);
        }
        let obj = tryParse(candidate);
        if (!obj) {
            // 08-13: the chat model writes file content as a RAW triple-quoted
            // string inside the JSON ("content":"""...""") — invalid JSON that
            // used to leak the whole reply to the client. Escape triple-quoted
            // regions (JSON.stringify handles the real newlines/quotes) and
            // re-parse; complex cases the regex can't fix hit the gateway's
            // MALFORMED correction and the model resends properly.
            const esc = candidate.replace(/"([A-Za-z_]\w*)"\s*:\s*"""([\s\S]*?)"""/g, (m, key, val) => `"${key}":${JSON.stringify(val)}`);
            if (esc !== candidate) obj = tryParse(esc);
        }
        // 08-19 (degradation fix): accept FLAT args in addition to the taught
        // {"tool","params"} wrapper. Gemini follows each tool's JSON schema
        // (parameters.properties.*) over the format example and emits
        // {"tool":"send_message","text":"..."} — the old `&& obj.params` gate
        // rejected that as malformed, sent a correction, and the model
        // re-emitted the SAME schema-driven shape forever (correction loop up
        // to the 3-round bail; it was round 16 before the bail existed). A
        // bare {"tool":"x"} with no args at all stays rejected (ambiguous).
        if (obj && typeof obj === 'object' && typeof obj.tool === 'string') {
            const flatArgs = { ...obj };
            delete flatArgs.tool;
            delete flatArgs.params;
            const args = obj.params ?? flatArgs;
            if (Object.keys(args).length > 0 || obj.params) {
                if (firstCallStart === -1) firstCallStart = start;
                result.toolCalls.push({ toolName: obj.tool, args });
            }
        }
        if (end === -1) break; // consumed the whole tail
        start = text.indexOf('{', start + 1);
    }
    if (firstCallStart !== -1) result.prose = cleanProse(text.slice(0, firstCallStart));
    return result;
}

// Single-call view for the existing callers (server.js tool loop pre-08-13).
function parseToolCall(response) {
    const r = parseToolCalls(response);
    if (r.toolCalls.length) {
        const c = r.toolCalls[0];
        return { isToolCall: true, toolName: c.toolName, args: c.args };
    }
    return { isToolCall: false, content: response };
}

// ──────────────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────────────
module.exports = {
    TOOL_DEFINITIONS,
    getToolDefinitions,
    executeTool,
    parseToolCall,
    parseToolCalls,
    cleanProse,
};
