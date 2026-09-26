const path = require('path');
const fs = require('fs');
const PATHS = require('../core/paths');
const os = require('os');
const { spawn } = require('child_process');
const config = require('../core/config');
const sandbox = require('./sandbox');
const bashGuard = require('./bash_guard');
const SPEND = require('../runtime/spend_ledger');
const platform = require('../core/platform');
const memory = require('../runtime/memory');

// 08-14 WEDGE ROOT-CAUSE ceiling: tool RESULTS must never round-trip a huge
// file through the chat tab (read_file on a 5.86MB state file → 6.2M-char
// prompt → tab choked, gateway wedged). See read_file handler.
const MAX_READ_FILE_CHARS = parseInt(process.env.MAX_READ_FILE_CHARS || '200000', 10);

// 09-12 (owner): "give them the tool call to see_next_chunk whenever output of
// any tool call is truncated". A truncated read used to be a dead end — the
// model saw `truncated:true` and either guessed at the missing lines or gave up
// with a cannot-fix. Remember where each read stopped so see_next_chunk can
// hand back the NEXT window instead of re-sending the same head.
const lastChunkEnd = new Map();
const CHUNK_CHARS = parseInt(process.env.CHUNK_CHARS || '20000', 10);

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
// TOOL DEFINITIONS
// ──────────────────────────────────────────────────────
// ── Paid search ──────────────────────────────────────────────────────────────
// Pinned to flash: the paid key is flash-only, never pro.
const SEARCH_MODEL = 'deepseek-v4-flash';
const SEARCH_API_URL = 'https://api.deepseek.com/anthropic/v1/messages';
// USD per million tokens, and per search request. These are CONSERVATIVE ESTIMATES
// set at or above flash list prices so the caps trip early rather than late; set the
// env vars to the current price sheet. The cap is only as honest as these numbers.
function searchCostUsd(usage) {
    const n = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
    const inTok = Number(usage && usage.input_tokens) || 0;
    const outTok = Number(usage && usage.output_tokens) || 0;
    const searches = Number(usage && usage.server_tool_use && usage.server_tool_use.web_search_requests) || 1;
    return inTok / 1e6 * n('SEARCH_PRICE_IN_PER_MTOK', 0.5)
        + outTok / 1e6 * n('SEARCH_PRICE_OUT_PER_MTOK', 2)
        + searches * n('SEARCH_PRICE_PER_REQUEST', 0.01);
}

const TOOL_DEFINITIONS = [
    {
        name: 'read_file',
        category: 'file',
        description: 'Read contents of a file. Hard ceiling: results are ALWAYS capped at 200K chars (truncated:true + totalLength), so a huge file can never balloon the chat — pass maxLength to control the window read.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to read' },
                // Optional head-only read: keeps big files (34KB App.jsx) from
                // ballooning the thread when only the top matters (08-12 context-
                // overflow spiral). Re-read WITHOUT maxLength before rewriting a
                // file so the rewrite never starts from a partial view.
                maxLength: { type: 'integer', description: 'Optional — read only the first N characters; the result flags truncation' },
            },
            required: ['path'],
        },
        handler: async (args) => {
            const sb = sandbox.denyResult(sandbox.checkPath(args.path));
            if (sb) return sb;
            const content = fs.readFileSync(args.path, 'utf-8');
            // 08-14 WEDGE ROOT-CAUSE: read_file without maxLength returned the
            // FULL file (5.86MB cross_eval_state.json) into the tool-result
            // message → next prompt = 6,197,724 chars → the webchat tab choked
            // and the gateway wedged on "Waiting for response..." for hours.
            // Hard ceiling regardless of args: a file this big must NEVER
            // round-trip through the tab, and explicit maxLength is clamped too.
            const limit = Math.min(args.maxLength || MAX_READ_FILE_CHARS, MAX_READ_FILE_CHARS);
            if (content.length > limit) {
                lastChunkEnd.set(args.path, limit);
                return {
                    success: true,
                    truncated: true,
                    totalLength: content.length,
                    content: content.slice(0, limit),
                    nextChunk: `Output truncated at ${limit} of ${content.length} chars. Call see_next_chunk with {"path":"${args.path}"} to read the next ${CHUNK_CHARS} chars, and keep calling it until you have the lines you need.`,
                };
            }
            lastChunkEnd.set(args.path, content.length);
            return { success: true, content };
        },
    },
    {
        // 09-12 (owner): the follow-up call for ANY truncated output. read_file
        // now answers a capped read with `nextChunk` naming this tool, so the
        // model has a real way to continue instead of guessing at the missing
        // lines or returning a cannot-fix. Calling it with no args continues
        // from where the last read of that file stopped.
        name: 'see_next_chunk',
        category: 'file',
        description: 'Read the NEXT chunk of a file whose output was truncated. Call this whenever a tool result says truncated:true / "output truncated" — repeat until you have the lines you need. With no offset it continues from where the last read stopped.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to continue reading' },
                offset: { type: 'integer', description: 'Optional character offset to start at; defaults to where the last read stopped' },
                length: { type: 'integer', description: `Optional number of characters to return (default ${CHUNK_CHARS})` },
            },
            required: ['path'],
        },
        handler: async (args) => {
            const sb = sandbox.denyResult(sandbox.checkPath(args.path));
            if (sb) return sb;
            const content = fs.readFileSync(args.path, 'utf-8');
            const start = Number.isInteger(args.offset) ? Math.max(0, args.offset) : (lastChunkEnd.get(args.path) || 0);
            const len = Math.min(args.length || CHUNK_CHARS, MAX_READ_FILE_CHARS);
            if (start >= content.length) {
                return { success: true, truncated: false, content: '', message: `End of ${args.path} (${content.length} chars). Nothing left to read.` };
            }
            const end = Math.min(content.length, start + len);
            lastChunkEnd.set(args.path, end);
            const more = end < content.length;
            return {
                success: true,
                truncated: more,
                offset: start,
                end,
                totalLength: content.length,
                content: content.slice(start, end),
                ...(more ? { nextChunk: `Call see_next_chunk with {"path":"${args.path}"} for the next ${CHUNK_CHARS} chars (at ${end} of ${content.length}).` } : {}),
            };
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
            const sb = sandbox.denyResult(sandbox.checkPath(args.path));
            if (sb) return sb;
            let oldContent = null;
            try {
                oldContent = fs.readFileSync(args.path, 'utf-8');
            } catch (e) {
                oldContent = null; // new file — no diff against anything
            }
            fs.writeFileSync(args.path, args.content, 'utf-8');
            return {
                success: true,
                message: `Written to ${args.path}`,
                oldContent,
                newLength: String(args.content ?? '').length,
            };
        },
    },
    {
        // SURGICAL EDIT — and the reason it exists is a measured failure, not tidiness.
        //
        // This harness had write_file and nothing else, so the smallest change cost a full
        // rewrite: a 3-line edit to a 297-line file meant emitting all 297 lines as one
        // JSON string. Models fail at that — they drop closing braces, silently truncate,
        // or leave the newlines raw — so simple edits failed far more often than they
        // should have. Measured: the lane read DataLakeView.jsx, was asked to change three
        // things, produced no write at all, ran the build, and reported success.
        //
        // A small bounded operation makes an impossible request routine: the model emits
        // the old text it saw and the new text it wants, and the tool proves the old text
        // existed exactly once before touching anything.
        //
        // Deliberately strict, because a fuzzy match on source code is a corruption risk:
        //   • old_string must be found, and found EXACTLY ONCE — a match appearing twice
        //     is ambiguous and is refused rather than guessed at.
        //   • A multi-line old_string must reproduce its own indentation verbatim.
        //   • Not-found and not-unique return actionable errors naming the fix, so the
        //     model can correct itself in one round instead of retrying blindly.
        //   • replace_all is opt-in and only for deliberately repetitive text.
        name: 'edit_file',
        category: 'file',
        description: 'Replace an exact string in a file. Use this for edits instead of rewriting the whole file. old_string must match EXACTLY ONCE, including its indentation.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to edit' },
                old_string: { type: 'string', description: 'The exact text to replace, indentation included. Must appear exactly once.' },
                new_string: { type: 'string', description: 'The replacement text. Use an empty string to delete the matched text.' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Use only for deliberately repeated text.' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
        handler: async (args) => {
            const sb = sandbox.denyResult(sandbox.checkPath(args.path));
            if (sb) return sb;
            let content;
            try {
                content = fs.readFileSync(args.path, 'utf-8');
            } catch (e) {
                return { success: false, error: `Could not read ${args.path}: ${e.message}`, content_is_error: true };
            }
            const oldStr = args.old_string;
            if (typeof oldStr !== 'string' || oldStr === '') {
                return { success: false, error: 'old_string is required and must be a non-empty string. To create a new file, use write_file.', content_is_error: true };
            }
            const count = content.split(oldStr).length - 1;
            if (count === 0) {
                // Name the likely cause rather than just reporting failure — an
                // unindented or partially-remembered snippet is the common case.
                const firstLine = oldStr.split('\n')[0].trim();
                let hint = 'Check the wording and the indentation — old_string must match the file byte for byte.';
                if (firstLine && content.includes(firstLine)) {
                    hint = `A line matching "${firstLine.slice(0, 60)}" exists, so the text is probably there but the indentation or the surrounding lines differ. Read the exact region with read_file and copy it verbatim.`;
                }
                return { success: false, error: `old_string was not found in ${args.path}. ${hint}`, content_is_error: true, found: 0 };
            }
            if (count > 1 && !args.replace_all) {
                return {
                    success: false,
                    error: `old_string appears ${count} times in ${args.path} — it is ambiguous, so nothing was changed. Include more surrounding lines to make it unique, or pass replace_all:true to change every occurrence.`,
                    content_is_error: true,
                    found: count,
                };
            }
            const newContent = args.replace_all ? content.split(oldStr).join(args.new_string) : content.replace(oldStr, () => args.new_string);
            fs.writeFileSync(args.path, newContent, 'utf-8');
            return {
                success: true,
                message: `Edited ${args.path} (${count} replacement${count === 1 ? '' : 's'})`,
                replacements: count,
                oldContent: content,
                newLength: newContent.length,
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
        // A1: a bash command the harness refuses to run must not be offered as if
        // it could. Filter it out when the gate is off, so the model never tries
        // it, gets a hard error, and loops.
        available: () => config.bashAllowed,
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
                const sbCheck = sandbox.checkCommand(args.command);
                if (!sbCheck.ok) {
                    return resolve({ success: false, error: sbCheck.error, sandbox: true });
                }
                const cmd = String(args.command || "");
                // 08-14 DENY-BY-DEFAULT guard (owner directive): hard-block
                // dangerous patterns even when BASH_ALLOWED=true. git push is
                // allowed ONLY to feature branches (explicit branch check).
                // Platform-specific: `rm -rf` means nothing to cmd, and
                // `del /f /s /q` means nothing to bash. One list applied
                // everywhere would let a destructive Windows command through.
                const denied = bashGuard.dangerDenial(cmd, {
                    windows: platform.isWindows(),
                    windowsPatterns: platform.dangerPatterns(),
                });
                if (denied) {
                    return resolve({ success: false, error: denied });
                }
                // git push goes only to a named feature branch. Read as argv per simple
                // command (bash_guard.js), because `HEAD:main`, `+master` and a trailing
                // `&& echo ok` all fooled the old split-on-space check.
                const pushDenied = bashGuard.pushDenial(cmd);
                if (pushDenied) {
                    return resolve({ success: false, error: pushDenied });
                }
                // Log EVERY executed command (denied ones are NOT executed).
                try {
                    fs.appendFileSync(
                        PATHS.bashToolLog(),
                        JSON.stringify({ ts: new Date().toISOString(), cmd }) + os.EOL
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
                // The shell comes from the platform module, not a literal. On Linux this
                // is `bash -s` exactly as before; on Windows it is cmd.exe, which takes
                // the script as an ARGUMENT (it has no stdin-script mode), so the spawn
                // shape follows the shell's declared capability rather than the OS name.
                const sh = platform.shell();
                const child = sh.stdinArgs
                    ? spawn(sh.cmd, sh.stdinArgs, { detached: true, stdio: ['pipe', outFd, errFd] })
                    : spawn(sh.cmd, sh.args(cmd), { detached: true, stdio: ['ignore', outFd, errFd] });
                if (sh.stdinArgs) {
                    // An 'error' on a pipe whose child already exited is emitted as a stream
                    // error, and an UNHANDLED one takes the whole process down — measured
                    // 2026-09-24: a duplicate write here raised ERR_STREAM_WRITE_AFTER_END,
                    // crashed the gateway, and every later request got a 502 that read as
                    // "the lane is slow". A dead child is an ordinary outcome; it must never
                    // be able to kill the server. The guard and the listener are both here
                    // because either one alone still leaves a crash path.
                    child.stdin.on('error', () => { /* child gone mid-write — finish() reports it */ });
                    if (child.stdin.writable) {
                        child.stdin.write(cmd);
                        child.stdin.end();
                    }
                }
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
            const sb = sandbox.denyResult(sandbox.checkPath(args.path));
            if (sb) return sb;
            const files = fs.readdirSync(args.path);
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
        //
        // 09-22 (owner): "add a websearch mcp that uses the webchat instead of a
        // paid api" — search_web no longer HARD-requires a key. DeepSeek and
        // Gemini have NATIVE search in their own UI, so for those lanes the
        // harness flips the lane's own Search control ON (browser.js ensureToggles,
        // config webchatModes.<mode>.native.search) and this tool — if the model
        // calls it anyway — tells it to ask directly instead of faking a search.
        // With no key and no native search, it returns ONE clear message so the
        // model never loops on an unavailable tool (A1).
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
        // A1: never advertise a tool whose requirement is unmet. search_web is
        // offered only when it can actually produce results — a paid key, or a
        // lane whose native search is switched on.
        available: () => config.webSearchAvailable,
        handler: async (args) => {
            const key = process.env.DEEPSEEK_API_KEY;
            if (!key) {
                // Keyless: native search lanes use their own UI search, and every
                // other lane gets a single clear unavailable message — never a
                // hard "disabled" error the model would retry in a loop.
                if (config.nativeSearch) {
                    return {
                        success: true,
                        native: true,
                        answer: 'Web search is handled natively by this webchat — the Search control is ON. ' +
                            'Ask your search question directly in your next message; do not call search_web.',
                    };
                }
                return {
                    success: false,
                    error: 'web search is not available on this lane: set DEEPSEEK_API_KEY for paid search, or ' +
                        'enable native search for deepseek/gemini (webchatModes.<mode>.native.search = true in ' +
                        'harness.config.json).',
                };
            }
            // Hard spend caps ($2/hour, $10/day by default), checked BEFORE the paid call.
            const budget = SPEND.check();
            if (!budget.ok) return { success: false, error: budget.error, budget_exhausted: true };
            const body = {
                model: SEARCH_MODEL,
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
                const resp = await fetch(SEARCH_API_URL, {
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
                // Charge what the call reports; when it reports nothing, charge the most it
                // could have cost, so a missing usage block can never read as free.
                const usage = data && data.usage ? data.usage : null;
                const usd = searchCostUsd(usage || {
                    input_tokens: Math.ceil(JSON.stringify(body).length / 4),
                    output_tokens: body.max_tokens,
                });
                SPEND.record(usd, 'search_web');
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
                const answer = textParts.join('\n').slice(0, 3000);
                // Nothing came back: say so. Reporting success here let the model go on to
                // "answer from the sources" it never received.
                if (!results.length && !answer.trim()) {
                    return { success: false, error: 'search returned no results', costUsd: usd };
                }
                return {
                    success: true,
                    answer,
                    results: results.slice(0, 8),
                    resultCount: results.length,
                    costUsd: usd,
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
            (config.narration
                ? 'Send a plain-text message to the user (delivered verbatim, rendered as "💬 <text>"). ' +
                  'Use this to acknowledge the user\'s message, narrate what you are about to do before ' +
                  'every other tool call, and to send your final summary. This is the ONLY way to ' +
                  'communicate in plain text.'
                : 'Send a plain-text message to the user (delivered verbatim, rendered as "💬 <text>"). ' +
                  'Use this only for the final summary or something the user must read — do NOT narrate ' +
                  'tool calls (narration is disabled: NARRATION=false).'),
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
            const wf = read(PATHS.workflowStateFile());
            const ad = read(PATHS.auditStateFile());
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
                    description: 'Repo: oculus (default), webchat-api, or helpotron',
                },
            },
            required: [],
        },
        handler: async (args) => {
            const repos = {
                oculus: path.join(PATHS.workspaceRoot(), 'oculus'),
                'webchat-api': path.join(PATHS.workspaceRoot(), 'webchat-api'),
                helpotron: path.join(PATHS.workspaceRoot(), 'helpotron'),
            };
            const dir = repos[String((args && args.repo) || 'oculus')];
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
            const OUTBOX = PATHS.outboxFile();
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
            const INBOX = PATHS.webchatInboxFile();
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
            const sendScript = process.env.TELEGRAM_SEND_SCRIPT
                || path.join(PATHS.workspaceRoot(), 'oculus', 'scripts', 'telegram_monitor', 'telegram-monitor', 'bin', 'send-telegram.sh');
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
    {
        // 09-22 (owner): "a memory file that the user or agent can edit." The
        // model reads and edits the persistent memory file through these two
        // tools, so facts survive across sends. The file is bounded (it rides
        // into every request's system prompt) — see memory.js.
        name: 'read_memory',
        category: 'memory',
        description: 'Read the persistent memory file. Use this to recall facts you or the user stored across sessions.',
        parameters: { type: 'object', properties: {}, required: [] },
        available: () => config.memoryEnabled,
        handler: async () => {
            const content = memory.readMemory();
            if (!content.trim()) return { success: true, content: '', message: 'Memory is empty.' };
            return { success: true, content };
        },
    },
    {
        // Whole-file replace or append. The file is capped at MAX_MEMORY_CHARS
        // (memory.js) so a bad edit cannot balloon the system prompt.
        name: 'edit_memory',
        category: 'memory',
        description: 'Edit the persistent memory file. Pass `content` to REPLACE the whole file, or `append` to add to the end. Persist anything you must remember across sends (decisions, facts, user preferences).',
        parameters: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'Full new contents (overwrites the file)' },
                append: { type: 'string', description: 'Text to append to the end of the file' },
            },
            required: [],
        },
        available: () => config.memoryEnabled,
        handler: async (args) => {
            const append = String(args?.append ?? '');
            const content = String(args?.content ?? '');
            if (!append && !content) return { success: false, error: 'pass content (replace) or append (add to the end)' };
            if (append && !content) {
                memory.appendMemory(append);
            } else {
                memory.writeMemory(content);
            }
            return { success: true, message: `Memory updated (${memory.readMemory().length} chars).` };
        },
    },
];

// ──────────────────────────────────────────────────────
// TOOL EXECUTOR
// ──────────────────────────────────────────────────────
function getToolDefinitions() {
    // Expose only the schema (name/category/description/parameters), never the handler
    return TOOL_DEFINITIONS.map(({ handler, available, ...rest }) => rest);
}

// 09-22 A1: the EXECUTABLE set. A tool whose `available()` predicate returns
// false (its requirement is unmet — no DEEPSEEK_API_KEY, bash gate off, memory
// disabled, …) is not advertised, so the model can never try it, hit a hard
// error, and loop. This is the fix for the user's "repeatedly trying unavailable
// tools".
// The tools the model is OFFERED. Must agree with isToolAvailable exactly — this
// used to re-implement the requirement check inline, so the user's deny list was
// honoured at execution time but the disabled tool was still ADVERTISED. A model
// offered a tool it cannot run tries it, fails, and burns rounds.
//
// There is one rule now, in one function: ask isToolAvailable.
function getExecutableToolDefinitions() {
    return TOOL_DEFINITIONS
        .filter((t) => isToolAvailable(t.name))
        .map(({ handler, available, ...rest }) => rest);
}

function isToolAvailable(toolName) {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
    if (!tool) return false;
    // ── The user's own deny list ──────────────────────────────────────────────
    // `tools.disabled` in harness.config.json (or DISABLED_TOOLS as a comma list)
    // switches a tool off entirely, on top of whatever requirement it already has.
    //
    // This is the ONLY place that needs to know: callers already ask this before
    // using a tool, and executeTool refuses anyway — so a newly disabled tool cannot
    // slip through a path that forgot to check. A disabled tool is also not
    // ADVERTISED (getExecutableToolDefinitions filters on this), which matters: a
    // model offered a tool it cannot run will try it, fail, and burn rounds.
    if (isToolDisabled(toolName)) return false;
    return typeof tool.available === 'function' ? tool.available() : true;
}

const LIMITS = require('./limits');

let _disabledTools = null;

function loadDisabledTools() {
    const set = new Set();
    const fromEnv = process.env.DISABLED_TOOLS;
    if (fromEnv) {
        for (const n of String(fromEnv).split(',')) {
            const t = n.trim();
            if (t) set.add(t);
        }
    }
    try {
        const MC = require('../core/master_config');
        const list = MC.pickList('DISABLED_TOOLS', 'tools', 'disabled');
        for (const n of (Array.isArray(list) ? list : [])) if (n) set.add(String(n));
    } catch { /* no master config — env alone is enough */ }
    return set;
}

function isToolDisabled(toolName) {
    try {
        if (!_disabledTools) _disabledTools = loadDisabledTools();
        return _disabledTools.has(String(toolName));
    } catch {
        // A broken config must not disable everything — fail OPEN, because every
        // tool still has its own requirement gate, and a config typo silently
        // removing all of them is far worse than one extra tool.
        return false;
    }
}

// Returns { error } or { args } with number/boolean fields spelled as strings
// coerced to their real type. The coercion matters: a handler reading
// `args.replace_all` treats the STRING "false" as truthy.
function validateArgs(tool, args) {
    const schema = tool.parameters || {};
    const props = schema.properties || {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'arguments must be a JSON object' };
    for (const name of schema.required || []) {
        if (args[name] === undefined || args[name] === null) return { error: `missing required argument "${name}"` };
    }
    const out = { ...args };
    for (const [name, value] of Object.entries(args)) {
        const want = props[name] && props[name].type;
        if (!want || value === undefined || value === null) continue;
        let ok = true;
        if (want === 'string') ok = typeof value === 'string';
        else if (want === 'boolean') {
            if (value === 'true' || value === 'false') out[name] = value === 'true';
            else ok = typeof value === 'boolean';
        } else if (want === 'number' || want === 'integer') {
            const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
            ok = typeof n === 'number' && Number.isFinite(n);
            if (ok) out[name] = n;
        } else if (want === 'array') ok = Array.isArray(value);
        else if (want === 'object') ok = typeof value === 'object' && !Array.isArray(value);
        if (!ok) return { error: `argument "${name}" must be a ${want}, got ${Array.isArray(value) ? 'array' : typeof value}` };
    }
    return { args: out };
}

async function executeTool(toolName, args, ctx) {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
    if (!tool) {
        return {
            success: false,
            error: `Tool "${toolName}" not found. Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}`,
        };
    }
    // A1: even if a tool somehow reaches the executor while its requirement is
    // unmet (a stale model message), refuse cleanly rather than half-running.
    if (typeof tool.available === 'function' && !tool.available()) {
        return {
            success: false,
            error: `Tool "${toolName}" is not available on this install (its requirement is unmet).`,
        };
    }
    // ── Schema: required arguments and their primitive types ─────────────────
    // The handlers trusted the model to send every required field. It does not:
    // edit_file without new_string ran content.replace(old, () => undefined) and
    // wrote the literal text "undefined" into the file, then reported success.
    // A call that does not match its own schema is refused before it runs.
    const checked = validateArgs(tool, args);
    if (checked.error) {
        console.warn(`⛔ ${toolName} refused: ${checked.error}`);
        return { success: false, error: `${toolName}: ${checked.error}. Resend the call with every required argument.`, content_is_error: true };
    }
    args = checked.args;
    // ── Per-tool limits ───────────────────────────────────────────────────────
    // Checked here, on the arguments, because this is the last point where the action can
    // still be stopped and the first point where its real arguments are known. A limit is
    // either a hard ban or an ask-the-user, and an ask applies in EVERY permission mode —
    // that is the whole point of it, so this deliberately does not consult the mode.
    const verdict = LIMITS.checkLimits(toolName, args);
    if (!verdict.allowed) {
        console.warn(`⛔ ${toolName} blocked by a ${verdict.enforce} limit (${verdict.pattern})`);
        return { success: false, error: LIMITS.refusalMessage(toolName, verdict), limit: verdict };
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
// Escape raw control characters that appear INSIDE a JSON string.
//
// A model writing a file emits the content as a JSON string, and it very often leaves
// the newlines RAW instead of writing \n:
//
//     {"tool":"write_file","content":"import React from 'react';
//     export default function X() {
//     ..."}
//
// That is invalid JSON, so JSON.parse rejects the whole envelope and the write is
// DISCARDED — the log says only "malformed tool JSON", a correction is sent, the model
// retries in the same shape, the rounds burn, and it eventually gives up and submits a
// summary. Measured: this is why the lane read for 34 tool calls and wrote nothing.
//
// The repair is safe in one direction only, which is the point: a raw newline, tab or
// carriage return is NOT legal inside a JSON string, so escaping one can only turn
// invalid JSON into valid JSON. It can never alter a document that already parsed.
function escapeRawControlCharsInStrings(s) {
    let out = '';
    let inString = false;
    let escaped = false;
    let changed = false;
    for (const ch of s) {
        if (inString) {
            if (escaped) { escaped = false; out += ch; continue; }
            if (ch === '\\') { escaped = true; out += ch; continue; }
            if (ch === '"') { inString = false; out += ch; continue; }
            if (ch === '\n') { out += '\\n'; changed = true; continue; }
            if (ch === '\r') { out += '\\r'; changed = true; continue; }
            if (ch === '\t') { out += '\\t'; changed = true; continue; }
            out += ch;
            continue;
        }
        if (ch === '"') inString = true;
        out += ch;
    }
    return { text: out, changed };
}

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
        // Gemini's code-block renderer stamps a bare `JSON` label before the fence,
        // and it survives into the extracted text as trailing prose:
        //   "💬 Checking git status... JSON {"tool":...}"
        // The prose is cut at the brace, so the label lands at the END of it and the
        // 💬 line the user reads ends with a stray "JSON".
        .replace(/\s*\bJSON\s*$/i, '')
        .replace(/\s+JSON\s+(?=\{)/gi, ' ')
        .replace(/```(?:json)?/gi, '')
        .replace(new RegExp('^\\s*' + chrome.source), '')
        .replace(new RegExp(chrome.source + '\\s*$'), '')
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
            // Repair #0, and the one that matters most for WRITES: raw newlines inside a
            // JSON string. A model writing a whole file emits multi-line content and
            // often forgets to escape the line breaks, which makes the envelope invalid
            // JSON and the entire write is thrown away. See the helper for why escaping
            // is safe in this direction only.
            const ctl = escapeRawControlCharsInStrings(candidate);
            if (ctl.changed) obj = tryParse(ctl.text);
        }
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
        // ACCEPT BOTH ARGUMENT SHAPES. There are two equally unambiguous ways to
        // write the same call, and the model uses whichever it feels like:
        //     {"tool":"git_status","params":{"repo":"helpotron"}}   nested
        //     {"tool":"git_status","repo":"helpotron"}              flat
        // The parser required `params`, so a flat call was rejected as malformed —
        // the correction was sent, the model retried in the SAME shape, the rounds
        // burned, and it eventually gave up and fabricated a summary.
        //
        // Measured on the Gemini lane: every tool call it emitted was flat.
        // `git_status` and `read_file` were both thrown away while the log said only
        // "malformed tool JSON" — and a parser that rejects valid input looks exactly
        // like a model that cannot produce valid output, which is why this hid behind
        // a model-reliability story for so long.
        //
        // Being liberal costs nothing: the envelope's shape cannot change the meaning.
        const _toolName = obj && typeof obj === 'object' ? (obj.tool || obj.name) : null;
        if (_toolName) {
            let _args = obj.params;
            if (typeof _args === 'string') {
                // {"tool":"submit_answer","params":"the answer"} — a scalar param
                // has exactly one sensible reading.
                _args = { text: _args };
            } else if (!_args || typeof _args !== 'object' || Array.isArray(_args)) {
                // Flat form: every key except the tool's own name/params is an arg.
                _args = {};
                for (const [k, v] of Object.entries(obj)) {
                    if (k === 'tool' || k === 'name' || k === 'params') continue;
                    _args[k] = v;
                }
            }
            if (firstCallStart === -1) firstCallStart = start;
            result.toolCalls.push({ toolName: String(_toolName), args: _args });
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
    getExecutableToolDefinitions,
    isToolAvailable,
    executeTool,
    checkLimits: LIMITS.checkLimits,
    limitsFor: LIMITS.limitsFor,
    parseToolCall,
    parseToolCalls,
    cleanProse,
};
