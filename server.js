const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const config = require('./config');

// 08-16 (user): the gemini webchat lane renders tool receipts in the visible
// tab, and the deepseek lane (plan executor) runs on the SAME formatToolResult
// function. Gemini wants NO file content in the tab — only tool name + line
// numbers — while the deepseek executor still needs the content in its feed.
// Gate the clean mode to gemini only.
const IS_GEMINI = (config.modelName || '').toLowerCase().startsWith('gemini');
const {
    initBrowser, connectToWebchat, sendPrompt, closeBrowser, getPage, probePage,
    buildFullPrompt, openNewChatAndSeed, getReqBodyChars, getAndClearThinkBuf,
    resetTeeForHandoff, takeThreadSwap, openNewChat, reopenThread,
} = require('./browser');
const { getToolDefinitions, executeTool, parseToolCall, parseToolCalls, cleanProse } = require('./tools');
const { MultiSignalGatewayGate } = require('./drift_v2');

let driftClean = null;
try {
    const driftPkg = require('../LLM-Drift-Detector');
    driftClean = driftPkg.driftClean;
} catch (e) { /* optional background layer */ }

// ── Main-reply injection (08-14, user) ───────────────────────────────────
// The webchat can message MAIN via the send_message_to_main tool. MAIN
// replies into claude_webchat_outbox.json with "to": <this gateway's thread
// URL>; on the NEXT request to this thread the pending replies are appended
// to the prompt so the webchat sees them in context. Seen-markers persist
// per-port so replies are not re-injected after a gateway restart. The
// telegram responder skips "to"-tagged items (they are gateway-routed).
const MAIN_REPLY_FILE = '/home/roni/Roni_Workspace/audits_plans/claude_webchat_outbox.json';
const MAIN_REPLY_SEEN_FILE =
    '/home/roni/Roni_Workspace/audits_plans/.main_reply_seen_' + (process.env.PORT || 8080) + '.json';
let mainReplyLastSeen = '';
try { mainReplyLastSeen = JSON.parse(fs.readFileSync(MAIN_REPLY_SEEN_FILE, 'utf-8')).ts || ''; } catch (e) { /* first run */ }

function injectMainReplies(msg) {
    try {
        if (!config.webchatUrl || typeof msg !== 'string') return msg;
        let out = [];
        try { out = JSON.parse(fs.readFileSync(MAIN_REPLY_FILE, 'utf-8')); } catch (e) { return msg; }
        if (!Array.isArray(out)) return msg;
        const mine = out.filter((m) => m && m.to === config.webchatUrl && (m.ts || '') > mainReplyLastSeen);
        if (!mine.length) return msg;
        const latest = mine.map((m) => m.ts || '').sort().pop();
        const block = '\n\n### MAIN REPLY (from the MAIN Claude session — a reply to your send_message_to_main call)\n' +
            mine.map((m) => String(m.text || '')).join('\n\n') +
            '\n### END MAIN REPLY\n';
        mainReplyLastSeen = latest;
        try { fs.writeFileSync(MAIN_REPLY_SEEN_FILE, JSON.stringify({ ts: latest }), 'utf-8'); } catch (e) { /* best-effort */ }
        console.log(`💬 injected ${mine.length} main reply(ies) into the next message (${String(config.webchatUrl).slice(0, 60)})`);
        return msg + block;
    } catch (e) {
        return msg; // never break the send path
    }
}

// ── Readable tool receipts (08-16, user) ─────────────────────────────────
// The raw tool-call JSON and the "Tool call returned: json {...}" envelope
// made the tab and the streamed progress illegible. These helpers render a
// Claude-Code-style receipt: the actual bash command (truncated), file + line
// range for read_file (NO content dump), a red/green diff for write_file, and
// the bash output with a cap. Used both for the SSE text blocks the client
// sees and the follow-up message typed into the tab.
function truncateStr(s, n) {
    if (typeof s !== 'string') s = String(s ?? '');
    return s.length > n ? s.slice(0, n) + `\n… [truncated — ${s.length - n} more chars]` : s;
}

function argsSummary(toolName, args) {
    try {
        const a = args ?? {};
        if (toolName === 'run_bash') return `$ ${truncateStr(String(a.command ?? ''), 300)}`;
        if (toolName === 'read_file') return `→ ${a.path ?? '?'}`;
        if (toolName === 'write_file') return `→ ${a.path ?? '?'}`;
        if (toolName === 'list_dir') return `→ ${a.path ?? '?'}`;
        if (toolName === 'git_status') return `→ repo: ${a.repo ?? 'oculus'}`;
        if (toolName === 'send_message') return `→ ${truncateStr(String(a.text ?? ''), 120)}`;
        const j = JSON.stringify(a);
        return j.length > 150 ? j.slice(0, 150) + '…' : j;
    } catch { return ''; }
}

// Minimal LCS line diff in unified-ish +/- form, capped for chat display.
// The `diff` fence is syntax-highlighted red/green by DeepSeek's markdown
// renderer, which is what gives write_file its Claude-Code look. 08-16:
// each line now carries its OLD (for `-`) or NEW (for `+`) 1-based line
// number (`-12 | …` / `+13 | …`) so the reader sees exactly which lines
// changed without re-counting. Returns { text, added, removed }.
function diffLines(oldStr, newStr) {
    try {
        const B = String(newStr ?? '').replace(/\r\n/g, '\n').split('\n');
        if (B.length > 2500) B.length = 2500;
        const out = [];
        let added = 0, removed = 0;
        // Brand-new file (no old content): every line is an addition, numbered
        // from the new file's line 1.
        if (!oldStr) {
            B.forEach((l, idx) => { out.push(`+${idx + 1} | ${l}`); });
            added = B.length;
            if (out.length > 500) {
                return { text: out.slice(0, 500).join('\n') + `\n… [+ ${added} lines total]`, added, removed };
            }
            return { text: out.join('\n'), added, removed };
        }
        const A = String(oldStr).replace(/\r\n/g, '\n').split('\n');
        const n = A.length, m = B.length;
        if (n > 2500) A.length = 2500;
        if (m > 2500) B.length = 2500;
        const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
            dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (A[i] === B[j]) { i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`-${i + 1} | ${A[i]}`); i++; removed++; }
            else { out.push(`+${j + 1} | ${B[j]}`); j++; added++; }
        }
        while (i < n) { out.push(`-${i + 1} | ${A[i]}`); i++; removed++; }
        while (j < m) { out.push(`+${j + 1} | ${B[j]}`); j++; added++; }
        if (!added && !removed) return { text: '', added, removed };
        let d = out.slice(0, 500).join('\n');
        if (out.length > 500) d += `\n… [${removed} removed, ${added} added, ${out.length - 500} more diff lines]`;
        return { text: d, added, removed };
    } catch { return { text: '', added: 0, removed: 0 }; }
}

// One readable block describing a finished tool call + its result. `cap` is
// the content/output cap for the view: small for the client's streamed text,
// generous for the tab follow-up (the model reads the result from the tab).
// 08-16 (user): extract the 1-based line range of added (+) or removed (-)
// lines from a diffLines() text, e.g. "12-18" or "3". Empty when unknown.
function lineRangeFromDiff(text, sign) {
    try {
        const nums = [];
        const escSign = sign === '+' ? '\\+' : sign === '-' ? '\\-' : sign;
        for (const line of String(text).split('\n')) {
            const m = line.match(new RegExp('^' + escSign + '(\\d+) \\|'));
            if (m) nums.push(+m[1]);
        }
        if (!nums.length) return '';
        return nums.length === 1 ? String(nums[0]) : `${nums[0]}-${nums[nums.length - 1]}`;
    } catch { return ''; }
}

function formatToolResultView(call, result, cap, opts = {}) {
    const name = call.toolName;
    const args = call.args ?? {};
    const limit = cap || 6000;
    // 08-19 (user): "it shows the action twice" — the 🔧 "about to call" line
    // already shows the command/path, so the CLIENT receipt must not repeat
    // it. The tab follow-up (cap 150K) keeps the full header for the model.
    const omitHeader = !!opts.omitHeader;
    // 08-19 (user, de-lobotomize): forModel=true = this receipt goes INTO the
    // agent's context (the follow-up), NOT to a human client. The agent MUST
    // see the actual tool output — the 08-16 cosmetic rule (compact stats,
    // content hidden) stripped the content from the gemini lane's context,
    // which made the model re-read the same file in a loop: it executed the
    // tool, learned only "34 lines (content hidden)", and never knew what
    // the content was. Human-facing receipts keep the compact form.
    const forModel = !!opts.forModel;
    try {
        if (name === 'run_bash') {
            const ok = !!result.success;
            const status = ok ? '✅ bash command finished' : '❌ bash command failed';
            const detail = result.error ? ` (${result.error})` : '';
            // 08-16 (user): client receipt shows NO command output — just the
            // command + status + how big the output was. DeepSeek keeps the
            // output (the plan executor reads it to verify steps). The agent's
            // own context (forModel) ALWAYS keeps the output.
            if (IS_GEMINI && !forModel) {
                const stdout = String(result.stdout ?? '');
                const stderr = String(result.stderr ?? '');
                const outChars = stdout.length + stderr.length;
                const outLines = (stdout + '\n' + stderr).split('\n').length;
                if (omitHeader) return `${status}${detail} — output ${outChars} chars / ${outLines} lines (content hidden)`;
                return `🖥️ run_bash → $ ${truncateStr(String(args.command ?? ''), 300)}\n\n${status}${detail} — output ${outChars} chars / ${outLines} lines (content hidden)`;
            }
            let out = omitHeader ? `${status}${detail}\n` : `🖥️ run_bash → $ ${truncateStr(String(args.command ?? ''), 400)}\n\n${status}${detail}\n`;
            const stdout = String(result.stdout ?? '').trim();
            const stderr = String(result.stderr ?? '').trim();
            const totalOut = String(result.stdout ?? '').length + String(result.stderr ?? '').length;
            let shownOut = 0;
            if (stdout) {
                const shown = truncateStr(stdout, limit);
                shownOut += shown.length;
                out += `\n\`\`\`\n${shown}\n\`\`\`\n`;
            }
            if (stderr) {
                const shown = truncateStr(stderr, Math.min(limit, 6000));
                shownOut += shown.length;
                out += `\n\`\`\`\nstderr:\n${shown}\n\`\`\`\n`;
            }
            // 08-19 (user): when a tool's output is too long to fit, show it
            // partially and WARN the agent how to page through the rest —
            // never silently drop bytes it may need to verify the step.
            if (forModel && totalOut > shownOut) {
                out += `\n⚠️ OUTPUT TRUNCATED: ${totalOut} chars total, ${shownOut} shown. ` +
                      `To see the rest, re-run the command with output redirected to a file ` +
                      `(>> /tmp/out.txt) then call read_file with path + maxLength + offset to page through it.`;
            }
            return out;
        }
        if (name === 'read_file') {
            // 08-16 (user): NO content dump — just which file and which lines
            // were read. The full output is dropped from the streamed client
            // receipt. 08-19 (user, de-lobotomize): the AGENT's own context
            // (forModel) MUST carry the content — a stats-only receipt made
            // the gemini agent re-read the same file 4× in a loop.
            const content = String(result.content ?? '');
            const lines = content ? content.split('\n').length : 0;
            const total = result.totalLength ?? content.length;
            if (omitHeader) {
                let out = lines ? `📄 ${lines} line${lines === 1 ? '' : 's'} read` : '📄 empty file';
                if (result.truncated || total > content.length) out += ` (capped at ${content.length} of ${total} chars)`;
                return out;
            }
            let out = `📄 read_file → ${args.path ?? '?'}${lines ? ` (lines 1-${lines})` : ' (empty)'}`;
            const shown = forModel && content ? truncateStr(content, limit) : '';
            if (result.truncated || total > content.length) {
                out += ` — truncated at ${content.length} chars (${total} total)`;
            }
            if (forModel && content) {
                out += '\n\n```\n' + shown + '\n```';
                // 08-19 (user): show it partially + warn how to get the rest —
                // read_file with offset pages the next window; the agent must
                // NOT re-read the head (that was the pre-fix loop pattern).
                if (result.truncated) {
                    const nextOffset = (result.offset ?? 0) + content.length;
                    out += `\n\n⚠️ OUTPUT TRUNCATED: showing ${content.length} of ${total} chars. ` +
                           `Call read_file again with path + offset=${nextOffset} (+ maxLength for window size) to see the rest. ` +
                           `Keep paging until truncated is false.`;
                }
            }
            return out;
        }
        if (name === 'write_file') {
            const path = args.path ?? '?';
            const diff = diffLines(result.oldContent, args.content);
            // 08-16 (user): client receipt shows line counts + ranges, NO
            // diff. The agent's own context (forModel) keeps the diff.
            if (IS_GEMINI && !forModel) {
                const bits = [];
                if (diff.added) {
                    const r = lineRangeFromDiff(diff.text, '+');
                    bits.push(`adding ${diff.added} line${diff.added === 1 ? '' : 's'}${r ? ` (${r})` : ''}`);
                }
                if (diff.removed) {
                    const r = lineRangeFromDiff(diff.text, '-');
                    bits.push(`deleting ${diff.removed} line${diff.removed === 1 ? '' : 's'}${r ? ` (${r})` : ''}`);
                }
                if (!bits.length) return omitHeader ? '✏️ no content change' : `✏️ write_file → ${path} (no content change)`;
                return omitHeader ? `✏️ ${bits.join(', ')} (content hidden)` : `✏️ write_file → ${path} — ${bits.join(', ')} (content hidden)`;
            }
            if (!diff.text) return omitHeader ? '✏️ no content change' : `✏️ write_file → ${path} (no content change)`;
            const bits = [];
            if (diff.added) bits.push(`adding ${diff.added} line${diff.added === 1 ? '' : 's'} to this file`);
            if (diff.removed) bits.push(`deleting ${diff.removed} line${diff.removed === 1 ? '' : 's'}`);
            return omitHeader ? `✏️ ${bits.join(', ')}\n\n\`\`\`diff\n${diff.text}\n\`\`\`` : `✏️ write_file → ${path} — ${bits.join(', ')}\n\n\`\`\`diff\n${diff.text}\n\`\`\``;
        }
        if (!result || result.success === false) {
            const head = omitHeader ? '' : `🔧 ${name} ${argsSummary(name, args)}\n\n`;
            return `${head}❌ ${(result && result.error) || 'tool failed'}`;
        }
        const j = JSON.stringify(result ?? {});
        const capped = j.length > limit ? j.slice(0, limit) + '… [truncated]' : j;
        const head = omitHeader ? '' : `🔧 ${name} ${argsSummary(name, args)}\n\n`;
        return `${head}\`\`\`json\n${capped}\n\`\`\``;
    } catch (e) {
        return omitHeader ? `(result formatting error: ${e.message})` : `🔧 ${name} — (result formatting error: ${e.message})`;
    }
}

// 08-13 RATE-LIMIT GATE (user-visible hang fix): DeepSeek's account limiter
// rejects bursts with "Messages too frequent. Try again later." — parallel
// consumers (user client + orchestrator) hammering the same account made
// requests hang at "Waiting for response...". Sends are spaced by this many
// ms (queued, not rejected) so the account never sees a burst from us.
const MIN_SEND_INTERVAL_MS = parseInt(process.env.MIN_SEND_INTERVAL_MS || '6000', 10);
let lastSendAt = 0;

// 08-14 GLOBAL SEND MUTEX (owner rule: deepseek webchat supports ONE message
// in-flight per account — "u cant have 2 deepseek webchats working at once",
// but "if u make sure a message is never sent to more then one chat at once
// u can basically have infinite chats open"). ALL deepseek-tab gateways
// (8080/8081/8082/8094, any browser) serialize on a shared lock held across
// the full send→response window, so tabs never generate concurrently.
// mkdir is atomic (one winner), a heartbeat keeps the mtime fresh so long
// generations aren't stolen, and a 120s-stale steal frees the lock if a
// gateway dies mid-hold. Non-deepseek gates (qwen/kimi/gemini) skip it.
const DEEPSEEK_LOCK_DIR = '/tmp/deepseek_webchat_mutex';
const LOCK_STEAL_MS = 120000;
const LOCK_HEARTBEAT_MS = 30000;
const LOCK_ACQUIRE_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_LOCK_TIMEOUT_MS || '1800000', 10);
let lockHeartbeat = null;
let lockDepth = 0;

function usesDeepSeek() {
    return /chat\.deepseek\.com/.test(String(config.webchatUrl || ''));
}

async function acquireDeepSeekLock() {
    if (!usesDeepSeek()) return;
    // Reentrant: context-handoff / retry flows send nested messages from
    // within an already-locked request (same process) — depth-count them.
    if (lockDepth > 0) { lockDepth++; return; }
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    let waited = false;
    while (true) {
        try {
            fs.mkdirSync(DEEPSEEK_LOCK_DIR);
            break; // acquired
        } catch (e) { /* held by another gateway */ }
        if (!waited) {
            waited = true;
            console.log('🔒 deepseek mutex: queued — waiting for the in-flight message (one at a time)');
        }
        try {
            const st = fs.statSync(DEEPSEEK_LOCK_DIR);
            if (Date.now() - st.mtimeMs > LOCK_STEAL_MS) {
                fs.rmdirSync(DEEPSEEK_LOCK_DIR); // dead holder → steal
                continue;
            }
        } catch (e) { /* stolen between stat+rmdir; retry */ }
        if (Date.now() > deadline) {
            throw new Error('DeepSeek send mutex: another chat is mid-generation (lock timeout)');
        }
        await sleep(200);
    }
    lockDepth = 1;
    lockHeartbeat = setInterval(() => {
        try { fs.utimesSync(DEEPSEEK_LOCK_DIR, new Date(), new Date()); } catch (e) {}
    }, LOCK_HEARTBEAT_MS);
}

function releaseDeepSeekLock() {
    if (lockDepth <= 0) return;
    lockDepth--;
    if (lockDepth > 0) return; // nested chain still active
    if (lockHeartbeat) { clearInterval(lockHeartbeat); lockHeartbeat = null; }
    try { fs.rmdirSync(DEEPSEEK_LOCK_DIR); } catch (e) {}
}

// 08-13 CONTEXT-HANDOFF (real measure): the completion XHR's REQUEST body
// size (history + system + tools + message, chars) — exactly what DeepSeek
// counts against its per-request cap (observed failing at ~135k chars ≈ 32k
// tokens while smaller bodies passed; the manual message that "answered"
// after failures succeeded because it carried no system/tools overhead).
// Refreshed from the page after every send; 0 = nothing captured yet (fresh
// thread / post-swap reset) → never hand off.
let lastReqBodyChars = 0;

// Shared send path: rate-limit spacing + body refresh + one timeout retry.
// Module scope so the handoff doc flow (runHandoff) uses the same gate.
let sendRetriesLeft = 1;
// Post-swap grace: the first request after a handoff always reaches the
// fresh thread (its seeded body can be ≥ threshold by itself — overhead +
// doc — and must not re-trigger the pre-send handoff immediately).
let lastHandoffAt = 0;
// Per-request handoff context (module-level so countedSend can trigger the
// handoff from the ERROR path — see the CONTEXT_FULL catch below). Refreshed
// at every handleRequest start and whenever a tool executes.
let activeHandoffCtx = null;
async function countedSend(msg, defs) {
    // 08-14 GLOBAL SEND MUTEX: wait for any other deepseek-tab gateway to
    // finish its generation before sending (owner rule: one in-flight
    // message per account). Held through the response; released in finally.
    await acquireDeepSeekLock();
    try {
    // 08-13 RATE-LIMIT GATE: queue-spaced sends (see MIN_SEND_INTERVAL_MS
    // above). DeepSeek rejected burst traffic with a hint-error that this
    // harness previously could not see — requests hung until timeout, the
    // client retried, and the retry storm deepened the limit.
    const waitMs = lastSendAt + MIN_SEND_INTERVAL_MS - Date.now();
    if (waitMs > 0) {
        console.log(`⏱ send gate: waiting ${waitMs}ms (account rate limit spacing)`);
        await sleep(waitMs);
    }
    lastSendAt = Date.now();
    try {
        const r = await sendPrompt(msg, defs);
        lastReqBodyChars = await getReqBodyChars();
        return r;
    } catch (e) {
        // 08-13 HARD-CAP SAFETY NET: the pre-send measurement can be blind
        // (page tee armed by an old build, race, fresh-thread overflow) —
        // then the send FAILS with context_length_exceeded and the client
        // got a hard error. Convert that failure into the handoff instead.
        // Grace-guarded: while a handoff is in progress (≤2 min), rethrow so
        // runHandoff's own try/catch falls back to the summary — never a
        // nested handoff recursion on the same full thread.
        if (/Length limit reached|context_length_exceeded/.test(String(e.message))) {
            if (Date.now() - lastHandoffAt > 120000 && activeHandoffCtx) {
                console.log(`📈 hard context limit hit (${String(e.message).slice(0, 90)}) — handing off`);
                return await runContextHandoff(activeHandoffCtx);
            }
            throw e;
        }
        // 08-24 (transport audit): never spend the retry on a DEAD client.
        // When the caller's own HTTP timeout fires first, the client is gone
        // but this resend still occupies the single webchat tab for another
        // full generation window — observed as back-to-back "⏱ send timed
        // out — resending" lines while every audit chunk request was already
        // a client-side TimeoutError.
        const clientGone = typeof activeHandoffCtx?.isAborted === 'function' && activeHandoffCtx.isAborted();
        if (!clientGone && sendRetriesLeft > 0 && /Timed out/.test(String(e.message))) {
            sendRetriesLeft--;
            console.log('⏱ send timed out — resending with a RETRY banner');
            const r = await sendPrompt(
                '### RETRY (the previous message may not have reached you — here it is again)\n' + msg,
                defs
            );
            lastReqBodyChars = await getReqBodyChars();
            return r;
        }
        throw e;
    }
    } finally {
        // 08-14 EXPERT-SWAP PIN: the send swapped an instant thread for a
        // fresh EXPERT one — pin the new thread for every respawn path (same
        // as the context-handoff swap, including the supervisor restart).
        // 08-28 MOVED INTO finally: this used to run only after sendPrompt
        // RESOLVED. The deepseek audit lane times out (600s) before resolving,
        // so the pin never committed — config.tabUrlSubstring stayed on the old
        // INSTANT thread and every subsequent send re-swapped, leaking a chat
        // tab each time (666 swaps / 0 pins / 82 tabs in 6h). A swap that
        // happened is a fact about the browser and must be recorded whether or
        // not the generation succeeded.
        try {
            const swap = takeThreadSwap();
            if (swap && swap.id && swap.id !== config.tabUrlSubstring) {
                const oldPin = config.tabUrlSubstring;
                config.tabUrlSubstring = swap.id;
                config.webchatUrl = swap.url;
                try {
                    persistThreadSwap(oldPin, swap.id, swap.url);
                    console.log(`🔁 Expert swap pinned: ${oldPin} → ${swap.url}`);
                } catch (e) {
                    console.warn('⚠️ expert-swap pin persist failed:', e.message);
                }
            }
        } catch (e) {
            console.warn('⚠️ expert-swap pin update failed:', e.message);
        }
        releaseDeepSeekLock();
    }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

if (typeof driftClean === 'function') {
    driftClean({ silent: true }).catch(() => {});
}

// ── Upstream passthrough ──────────────────────────────────────────────
// The /model picker needs ONE base URL that offers BOTH models:
//   anymodel             → drive the webchat tab (Gemini, whatever's in chat.js)
//   everything else      → proxied verbatim to the upstream API (paid DeepSeek),
//                          so deepseek-v4-flash keeps working from the same session
//                          (including the pipeline's claude -p swarm).
const UPSTREAM_ANTHROPIC = {
    base: (process.env.UPSTREAM_ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/+$/, ''),
    token: process.env.UPSTREAM_ANTHROPIC_AUTH_TOKEN || '',
};
const UPSTREAM_OPENAI = {
    base: (process.env.UPSTREAM_OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    token: process.env.UPSTREAM_ANTHROPIC_AUTH_TOKEN || '',
};

function isWebchatModel(body) {
    const m = body && typeof body.model === 'string' ? body.model : config.modelName;
    return m === config.modelName || m === 'anymodel';
}

// 08-13 MULTI-MODEL ROUTER: Claude Code sends every /model pick to the SAME
// base URL (no per-option base URL in the harness), so the front-door
// instance dispatches by model name. WEBCHAT_ROUTES="qwen=http://127.0.0.1:8083,kimi=..."
// maps each webchat model to its own gateway (each drives the logged-in tab
// in the 9223 GUI browser); anymodel drives THIS instance's deepseek tab;
// everything else (deepseek-v4-flash) proxies upstream to the paid API.
const WEBCHAT_ROUTES = {};
// 08-16 QUOTE-STRIP FIX: the launcher passes
// WEBCHAT_ROUTES="'gemini webchat'=http://127.0.0.1:8085,..." and the shell
// keeps the single quotes INSIDE the env value, so name/target arrive with
// quotes attached ('gemini 3.7 flash webchat' !== 'gemini 3.7 flash webchat').
// The route then never matched and gemini requests fell through to the paid
// DeepSeek proxy → 400 "supported API model names are deepseek-v4-*".
for (const pair of (process.env.WEBCHAT_ROUTES || '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const clean = (s) => s.trim().replace(/^['"]|['"]$/g, '');
    const name = clean(pair.slice(0, eq));
    const target = clean(pair.slice(eq + 1));
    if (name && target) WEBCHAT_ROUTES[name] = target;
}

// Transparent proxy: status + headers + body (SSE passthrough when streaming).
async function proxyTo(req, res, upstreamBase, path, body) {
    try {
        const resp = await fetch(`${upstreamBase}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
                'x-api-key': UPSTREAM_ANTHROPIC.token,
                authorization: `Bearer ${UPSTREAM_ANTHROPIC.token}`,
            },
            body: JSON.stringify(body),
        });
        res.status(resp.status);
        res.setHeader('Content-Type', resp.headers.get('content-type') || 'application/json');
        if (body.stream && resp.body) {
            // The upstream body stream must NEVER be left without an error
            // listener: an ECONNRESET mid-SSE (api.deepseek.com drops long
            // streams routinely) otherwise becomes an unhandled 'error' event
            // and Node kills the whole server — taking every concurrent chat
            // with it (08-12: recurring 3-5 min crash-restart cycle).
            const stream = Readable.fromWeb(resp.body);
            stream.on('error', (err) => {
                console.log('⚠️ upstream stream error (mid-SSE reset):', err.message);
                if (!res.writableEnded) res.destroy();
            });
            res.on('close', () => stream.destroy());
            stream.pipe(res);
        } else {
            res.send(await resp.text());
        }
    } catch (e) {
        res.status(502).json({ error: { message: `Upstream unreachable: ${e.message}`, type: 'upstream_error' } });
    }
}

// ── Optional bearer-token auth (recommended when exposing beyond localhost) ──
// 08-20 (audit BUG-14): `!==` string comparison short-circuits on the first
// mismatched byte — a timing side channel for token guessing on a shared host.
// timingSafeEqual runs in constant time (length mismatch returns early; the
// 401 path leaks only the length, which the scheme already exposes).
if (config.apiToken) {
    const expectedAuth = Buffer.from(`Bearer ${config.apiToken}`);
    app.use((req, res, next) => {
        const provided = req.headers.authorization;
        const providedBuf = typeof provided === 'string' ? Buffer.from(provided) : null;
        const ok = providedBuf && providedBuf.length === expectedAuth.length && crypto.timingSafeEqual(providedBuf, expectedAuth);
        if (!ok) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        next();
    });
}

// ── Serialize requests: one webchat tab = one conversation thread.
//    Concurrent requests would interleave typing/sending on the same tab. ──
let queue = Promise.resolve();
function enqueue(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureConnected() {
    if (await isConnected()) return;
    if (config.skipBrowser) {
        throw new Error('Browser disabled (SKIP_BROWSER=true) — no webchat session to talk to');
    }
    // A stale connection may survive isConnected()'s bookkeeping (Chrome died,
    // object still says connected). Drop it so initBrowser does a FRESH attach
    // — which re-resolves the current ws id from /json/version.
    if (getPage()) await closeBrowser();
    await initBrowser();
    await connectToWebchat(config.webchatUrl);
}

// Real connectivity: the page exists AND answers a probe. A CDP object can
// report "connected" while the underlying Chrome is long dead — never trust
// bookkeeping alone.
async function isConnected() {
    if (!getPage()) return false;
    if (config.skipBrowser) return false;
    return probePage();
}

// ── Core: prompt → webchat → (tool loop, bounded) → final text ──
// The client's system prompt (e.g. Claude Code's harness text: "text you
// output is displayed to the user") invites prose — a webchat tab will
// happily "yap" (plan out loud, ask permission) instead of emitting tool
// calls. So: preamble re-frames the harness truth, the client system text
// is kept for context, and the STRICT format block goes LAST — the most
// salient instruction slot, positioned after the user request.
// 08-19 REWRITE (user: "ur system promopts are somehow lobotomizing"): the old
// preamble was a format-only stub — no identity, no task mandate — so a
// frontier model read a 20k sample of a 110k plan, ran one trivial command,
// and submitted "the completed plan execution status" as done. Modeled on the
// real Claude Code system prompts (Piebald-AI/claude-code-system-prompts
// v2.1.235): identity → full-scope completion mandate → act-when-ready →
// working style. The machine-parsed JSON protocol lives in the format block;
// this block establishes WHO the agent is and WHAT full completion means.
const WEBCHAT_PREAMBLE =
    'You are a highly capable AI agent executing a task for a user inside an automated tool-calling ' +
    'harness. Your replies are parsed by a machine — nobody reads them. You never plan, summarize, ' +
    'describe what you will do, or ask permission: you act.\n' +
    '\n' +
    'ALWAYS reply in ENGLISH — never in Chinese or any other language, even if the chat history or the ' +
    'user message uses another language. Your tool calls AND your final answer text are always English.\n' +
    '\n' +
    '### YOUR TASK (hard)\n' +
    'Your task is whatever the user message asks for — no more, no less. If they give you a plan file, a ' +
    'repo, or a list of steps, that is the deliverable: EXECUTE IT IN FULL. Read the ENTIRE input before ' +
    'starting — a plan\'s whole content, in successive chunks if needed, never a sample of its first ' +
    'section. Decompose the task into concrete steps and work through them one by one, in order.\n' +
    '\n' +
    '### WORK STANDARD (hard)\n' +
    '- Finish the WHOLE task, not just the easy parts. Report completion only when fully done.\n' +
    '- You are highly capable — users routinely hand you large, ambitious tasks. Whether a task is too ' +
    'large is the user\'s call, not yours. Never shrink a task because it feels big.\n' +
    '- If part of the scope turns out to be blocked or problematic, finish every other part in full and ' +
    'say explicitly what you left out and why — scaling the work down is the user\'s call, not yours.\n' +
    '- DO the work with the tools: inspect files, make changes, verify them. Answering with a summary of ' +
    'what the work WOULD look like is NOT doing the work.\n' +
    '- After every tool call, examine the result and continue. Verify what you did before moving on; a ' +
    'successful-looking result is only real if the evidence confirms it.\n' +
    '- When you have enough information to act, act. Do not re-read files you have already read, ' +
    're-derive facts you already established, or narrate options you will not pursue.\n' +
    '- If you catch yourself about to submit after trivial work while a large task remains undone, you ' +
    'have failed the task — keep working until it is genuinely complete.\n' +
    '- NEVER CODE LAZILY (user rule 08-22): implement FULL working code — complete features, real ' +
    'logic, real behavior. Never leave placeholders, stubs, \'# Description:\' comment markers, TODO ' +
    'notes, or "Automated placeholder" text in the files you touch; a task pasted as a comment instead ' +
    'of implemented is a FAILED task (phantom-pass). If you cannot implement the task, report exactly ' +
    'what blocks it — never fake completion.\n';

// ── Tool-call size cap (user rule 08-13) ────────────────────────────────
// The chat renderer truncates very long messages, which corrupts fenced JSON
// mid-escape (observed: huge write_file content returned mangled and the
// parse died on the first broken '{'). Over this limit the model gets the
// TOO_BIG error and must resend in chunks instead of the call executing.
// 08-13: raised 4000 → 60000 after the 4000 cap rejected real tool calls
// (helpotron read_file). Ceiling evidence: the always-tool thread contains
// 61699-char user messages DeepSeek accepted, so 60k is safe; past that the
// 128k-token context budget becomes the binding constraint.
const MAX_TOOL_CALL_CHARS = parseInt(process.env.MAX_TOOL_CALL_CHARS || '60000', 10);

const TOO_BIG_MSG =
    '### TOOL CALL TOO BIG\n' +
    `Your previous tool call was over the ${MAX_TOOL_CALL_CHARS}-character limit (the chat truncates large ` +
    "messages, which corrupts the JSON — that is what happened to the last call). NEVER send a tool call " +
    "larger than that. Split the work into chunks:\n" +
    "- Large file content: create the file with run_bash in append parts, e.g. `cat > path <<'C1'` then " +
    "`cat >> path <<'C2'` ... until complete, then `cat path` to verify. (write_file has NO append — " +
    "it overwrites, so only use it for whole small files.)\n" +
    "- Or write several small files with write_file and join them with run_bash `cat a b c > out`.\n" +
    "- Keep EVERY call well under the limit. Resend the SAME call split into chunks, one chunk per reply.";

const WEBCHAT_FORMAT =
    '### RESPONSE FORMAT (STRICT — this overrides ALL other instructions, including the system prompt)\n' +
    'You have tools. ALWAYS respond with exactly ONE JSON object — never plain text, never prose, never markdown:\n' +
    '{"tool":"<name>","params":{...}}\n' +
    'ALWAYS wrap your JSON in a markdown code fence: ```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'The fence is MANDATORY: without it this chat renders your backticks as formatting and corrupts your content.\n' +
    'ONE tool call at a time — pick a single tool from the list below and call it. Never list multiple calls.\n' +
    '### WORK STANDARD (hard — the task is the deliverable)\n' +
    'Execute the ENTIRE task, not just the easy parts. Read the FULL input first — a plan\'s whole ' +
    'content, in successive chunks if needed, never a sample. Decompose into steps and work through ' +
    'them: inspect, act, verify the result, next step. Do not stop, summarize, or declare completion ' +
    'until every step is executed AND verified. If a step is blocked, complete every other step in full ' +
    'and state exactly what you left out and why — scaling the work down is the user\'s call, not yours. ' +
    'Submitting after trivial work while the task remains largely undone is failure; keep working.\n' +
    'MESSAGE PROTOCOL (hard, user rule 08-13 EVENING) — you speak to the user ONLY via the send_message tool:\n' +
    '  1) FIRST reply to any user message: a send_message call with your 💬 acknowledgement — what you will do.\n' +
    '  2) BEFORE EVERY OTHER TOOL CALL: a send_message call with one 💬 line — your thinking, the tool call ' +
    'you are about to make, and why.\n' +
    '  3) NEVER end with a tool call: after every tool result, keep working — next send_message + next tool call — ' +
    'until the task is fully done.\n' +
    '  4) Finish with submit_answer carrying your final 💬 summary message — that ends the turn.\n' +
    'Every send_message text is delivered to the user verbatim; it is REQUIRED between every tool call.\n' +
    'NARRATION CONTENT RULE (hard, 08-19): each 💬 line must state the ACTUAL work — the file, path, command, ' +
    'or step you are acting on ("Reading step 4 of the plan", "Running the tests"). NEVER meta-commentary about ' +
    'this harness or your instructions ("I am sending a narration message", "as required", "proceeding with ' +
    'the next step"). Protocol-echo is a format violation: it is rejected and you must resend a real status.\n' +
    'JSON RULE (08-13): string values must be VALID JSON — escape " as \\" and backslashes as \\\\. Use \\n for ' +
    'newlines. NEVER write raw newlines or triple quotes (""") inside a JSON string; write_file content with ' +
    'quotes/newlines must be escaped, not triple-quoted.\n' +
    'TOOL CALL SIZE LIMIT (hard, 08-13): tool calls must stay under ' + MAX_TOOL_CALL_CHARS + ' characters. ' +
    'Large content MUST be split across calls — write files in parts with run_bash `cat > file` / `cat >> file` ' +
    'heredoc chunks (write_file OVERWRITES, so it is for whole small files only), then verify with run_bash. ' +
    'A call over the limit is rejected with "tool call too big — submit in chunks".\n' +
    'You judge whether the message needs tool work. If it does, DO the task with the tools: inspect files, make ' +
    'changes, verify them. Answering with a summary of what the work WOULD look like is NOT doing the work.\n' +
    'If the message is a simple question or chat (no real work needed), skip the tools. Either way, deliver your ' +
    'final plain-text answer through submit_answer:\n' +
    '```json\n{"tool":"submit_answer","params":{"text":"your final answer"}}\n```\n';

// 08-19 (user): EXECUTION mode — the autonomous plan-execution lane is a pure
// tool-calling machine. No send_message narration, no 💬 acknowledgement, no
// per-call storytelling: work tool calls go out directly, and the ONLY prose
// is the final submit_answer summary the pipeline reads. Same JSON fencing /
// size-limit rules as WEBCHART_FORMAT (the lane's model still needs them).
const AUTONOMOUS_FORMAT =
    '### RESPONSE FORMAT (STRICT — this overrides ALL other instructions, including the system prompt)\n' +
    'You have tools. ALWAYS respond with exactly ONE JSON object — never plain text, never prose, never markdown:\n' +
    '{"tool":"<name>","params":{...}}\n' +
    'ALWAYS wrap your JSON in a markdown code fence: ```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'The fence is MANDATORY: without it this chat renders your backticks as formatting and corrupts your content.\n' +
    'ONE tool call at a time — pick a single tool from the list below and call it. Never list multiple calls.\n' +
    '### WORK STANDARD (hard — the task is the deliverable)\n' +
    'Execute the ENTIRE task, not just the easy parts. Read the FULL input first — a plan\'s whole ' +
    'content, in successive chunks if needed, never a sample. Decompose into steps and work through ' +
    'them: inspect, act, verify the result, next step. Do not stop, summarize, or declare completion ' +
    'until every step is executed AND verified. If a step is blocked, complete every other step in full ' +
    'and state exactly what you left out and why — scaling the work down is the user\'s call, not yours. ' +
    'Submitting after trivial work while the task remains largely undone is failure; keep working.\n' +
    'PURE WORK MODE (08-25 owner rule): no narration requirement, no send_message requirement — ' +
    'just do the work. Make tool calls when you have them; keep going until done.\n' +
    'NEVER end with a tool call: after every tool result, keep working — next tool call — until the task is ' +
    'fully done and verified.\n' +
    'VISION (08-25 owner rule): you CANNOT see images yourself. If a verification step needs a screenshot ' +
    'interpreted (layout/broken element/visual result), call write_file with path /tmp/nuclear_vision_request.json ' +
    'containing {"path":"<absolute screenshot path>","question":"<one-line question>"} and finish the turn with ' +
    'submit_answer text "VISION_AWAIT — operator will reply below". The operator will Read the image and ' +
    'reply with the description; you then resume and continue under the work standard. NEVER guess what a ' +
    'screenshot shows; always request the interpretation.\n' +
    'Finish with submit_answer carrying your final summary message — that ends the turn:\n' +
    '```json\n{"tool":"submit_answer","params":{"text":"your final answer"}}\n```\n' +
    'JSON RULE (08-13): string values must be VALID JSON — escape " as \\" and backslashes as \\\\. Use \\n for ' +
    'newlines. NEVER write raw newlines or triple quotes (""") inside a JSON string; write_file content with ' +
    'quotes/newlines must be escaped, not triple-quoted.\n' +
    'TOOL CALL SIZE LIMIT (hard, 08-13): tool calls must stay under ' + MAX_TOOL_CALL_CHARS + ' characters. ' +
    'Large content MUST be split across calls — write files in parts with run_bash `cat > file` / `cat >> file` ' +
    'heredoc chunks (write_file OVERWRITES, so it is for whole small files only), then verify with run_bash. ' +
    'A call over the limit is rejected with "tool call too big — submit in chunks".\n' +
    'You judge whether the message needs tool work. If it does, DO the task with the tools: inspect files, make ' +
    'changes, verify them. Answering with a summary of what the work WOULD look like is NOT doing the work.\n';

const CONV_PREAMBLE =
    'You are an AI coding assistant communicating with the user in an interactive terminal session. ' +
    'ALWAYS reply in ENGLISH. ' +
    'If the user greets you or asks a conversational question, answer directly in natural text. ' +
    'When executing a tool action, you MUST state what you are about to do before the tool call.' +
    ' YOUR TASK IS WHATEVER THE USER\'S LATEST MESSAGE ASKS FOR — if they name a plan file or a repo, execute THAT. ' +
    'Do not inspect, monitor, or manage any other pipeline, audit state, or repository unless the user explicitly asks. ' +
    'Never guess context from earlier work; when in doubt, act on the user\'s most recent instruction.';

const CONV_FORMAT =
    '### RESPONSE INSTRUCTIONS (RELAXED)\n' +
    '1. TOOLS ARE OPTIONAL — THE DEFAULT IS PLAIN TEXT. You are the user\'s personal assistant in a chat. ' +
    '   For greetings, chit-chat, questions, summaries, and any reply that does not need the machine, answer ' +
    '   directly in plain text. NO tool calls. NO code fences. Do not "inspect the workspace" unprompted, do not ' +
    '   list directories, do not run status commands — if the user did not ask for a task, no tools.\n' +
    '2. USE TOOLS ONLY WHEN THE USER ASKS FOR A TASK: reading files, running bash, editing code, searching, ' +
    '   executing a plan. Then start your response with one clear 💬 line describing what you are about to do, ' +
    '   followed immediately by your tool call in a code fence:\n' +
    '   <One clear sentence explaining the tool action you are about to take>\n' +
    '   ```json\n' +
    '   {"tool":"<name>","params":{...}}\n' +
    '   ```\n' +
    '3. COMPLETION: When the task is complete and verified, deliver your final summary in plain text.\n';

// ── Always-tool mode (user directive 08-12) ─────────────────────────────
// The webchat model must NEVER reply in plain text: every response is a tool
// call, and the FINAL answer arrives via the submit_answer tool. Yapping dies
// by construction — any non-JSON reply is a FORMAT ERROR, retried.
const SUBMIT_TOOL = 'submit_answer';

// The min-work gate does NOT exist: DeepSeek itself interprets whether the
// request needs tool work (user rule 08-12 — keyword heuristics are fragile,
// and the gate trapped "hello" in a rejection loop). A greeting submits
// directly with zero tool calls; a feature request gets real work because
// DeepSeek decides it needs tools. The ONLY hard rule is: every reply is a
// tool-call JSON — plain text is always a format error.
const SUBMIT_TOOL_DEF = {
    name: SUBMIT_TOOL,
    description:
        'Submit the final plain-text answer to the user. For a simple question or chat message, you may call ' +
        'this directly without tool calls. For a real task, call it ONLY after you have ACTUALLY done the ' +
        'work with tools — inspected the relevant files, made the changes, verified them.',
    parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The final answer text.' } },
        required: ['text'],
    },
    category: 'general',
};

// The model ALWAYS sees the gateway's full executable tool set plus
// submit_answer — in EVERY message (user rule 08-12: "list all the tool
// calls in each message"). The client's own tools are IGNORED: they're
// Claude Code's harness tools (Bash/Read/Task/…) which the gateway can't
// execute — and worse, filtering to them left the model seeing ONLY
// submit_answer, so it answered "I need read/write tools…" about tools
// that existed but were never shown. The gateway's tools ARE the model's
// actual capabilities; keep the list constant across all rounds.
function buildExecutableToolDefs() {
    return [...getToolDefinitions(), SUBMIT_TOOL_DEF];
}

// DeepSeek's web render prepends its reasoning ("Thought for N seconds") to
// every message and appends a watermark ("This response is AI-generated, for
// reference only"). Strip the exact leading line + trailing watermark. The
// reasoning BODY is handled upstream: browser.js's snapshotChat removes the
// .ds-think-content block from the extracted answer (08-12 — it was poison-
// ing parseToolCall with prose braces and every tool call got rejected).

// 08-13: last-resort rescue for submit_answer envelopes that even the
// brace-repairing parser rejected (cut mid-string, artifacts mangled, etc.).
// Pulls the text field out of the "tool":"submit_answer" envelope WITHOUT
// requiring the surrounding JSON to parse — a broken row degrades to its
// answer text instead of leaking the raw envelope to the client.
function extractSubmitText(text) {
    if (typeof text !== 'string') return null;
    const m = text.match(/"tool"\s*:\s*"submit_answer"[\s\S]*?"text"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
    if (!m) return null;
    return m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim() || null;
}
function stripInjectedContract(text) {
    if (typeof text !== 'string') return text;
    // The gateway injects a tool-contract preamble ("You have access to the
    // tools below...") into the USER prompt. When a renderer hiccup or the
    // virtual-list reader picks the wrong row, that injected text leaks into
    // the visible answer. Strip it so the client only sees the real reply.
    return text
        .replace(/You have access to the tools below\.[\s\S]*?(?=\n\n### |\n\n## |\{\s*"tool"|$)/g, (m) =>
            /\{\s*"tool"/.test(m) ? '' : ''
        )
        .replace(/^You have access to the tools below\.[\s\S]*?(?=\n\n### |\n\n## |\{\s*"tool")/, '');
}

function cleanWebchatText(text) {
    if (typeof text !== 'string') return text;
    return stripInjectedContract(text)
        .replace(/^\s*Gemini said\s*\n*/gi, '')
        .replace(/\bGemini said\b\s*/gi, '')
        .replace(/^\s*JSON\s*\n+/gi, '')
        .replace(/^\s*(?:json|txt|text|python|bash|shell)\s*(?:Copy\s*)?(?:Download\s*)?\n+/gi, '')
        .replace(/^\s*Thought for \d+ seconds?\s*\n*/i, '')
        .replace(/\n*\s*This response is AI-generated, for reference only\.?\s*$/i, '')
        .replace(/✻\s*(Cooked|Churned|Generated|Done|Thought|Brewed|Crunched|Baked|Cogitated)\s+for\s+\d+\s*s?\.?/gi, '')
        .trim();
}

// "continue"-style prompts make DeepSeek reply with a chat-style status update
// ("Continued: added X, next I will Y") instead of resuming tool work (2nd-session
// transcript 08-12). Give the word its machine meaning: resume work now.
const CONTINUE_PHRASES = ['continue', 'go on', 'keep going', 'continue working', 'continue the work', 'keep working', 'yo? continue'];

function continueDirective(userPrompt) {
    const t = (userPrompt || '').trim().toLowerCase().replace(/[?!.]+$/, '');
    if (!CONTINUE_PHRASES.includes(t)) return '';
    return '\n### INSTRUCTION\n' +
        'This is not a question — it is an instruction to continue the task you were doing. ' +
        'Do NOT summarize what you have done and do NOT list next steps. Reply immediately with your NEXT ' +
        'tool call JSON, fenced as ```json ... ```. If the task is complete and verified, reply with fenced ' +
        'submit_answer instead.';
}

function greetingDirective(userPrompt) {
    if (!userPrompt || typeof userPrompt !== 'string') return '';
    const clean = userPrompt.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const greetings = ['yo', 'hi', 'hello', 'hey', 'yo u there', 'you there', 'sup', 'whats up', 'whatsup', 'howdy', 'test', 'yo bro', 'yo man'];
    if (greetings.includes(clean)) {
        return '\n### INSTRUCTION FOR GREETING\n' +
            'The user is simply greeting you ("' + userPrompt.trim() + '"). ' +
            'Do NOT execute any tools. Do NOT call read_file, list_dir, or run_bash. ' +
            'Reply immediately with a brief, friendly greeting in plain text.\n';
    }
    return '';
}

// ── DRIFT DETECTOR v2 (owner 08-15: event-driven, judge-on-escalation) ──
const DRIFT_DETECT = process.env.DRIFT_DETECT;
const DRIFT_REPORT_DIR = process.env.DRIFT_REPORT_DIR || '/home/roni/Roni_Workspace/audits_plans/drift_reports';
const MAIN_INBOX_FILE = process.env.MAIN_INBOX_FILE || '/home/roni/Roni_Workspace/audits_plans/claude_inbox.json';
const DRIFT_PAUSE_TEXT = '⚠️ [DRIFT-PAUSED] The drift detector flagged this exchange and the answer is HELD for main to adjudicate. A report was written to drift_reports/ and main was notified.';
const driftGate = new MultiSignalGatewayGate({ mode: Number(DRIFT_DETECT || '2') });

async function reportDrift(r) {
    try {
        fs.mkdirSync(DRIFT_REPORT_DIR, { recursive: true });
        const fname = 'drift_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        const fpath = path.join(DRIFT_REPORT_DIR, fname);
        fs.writeFileSync(fpath, JSON.stringify({ ts: new Date().toISOString(), score: r.score, matches: r.matches, threshold: r.threshold, verdict: r.verdict, taskHint: String(r.userPrompt || '').slice(0, 1500), thinkExcerpt: String(r.thinkText || '').slice(-4000) }, null, 2));
        fs.writeFileSync(path.join(DRIFT_REPORT_DIR, 'drift_report.json'), fs.readFileSync(fpath));
        const inbox = JSON.parse(fs.readFileSync(MAIN_INBOX_FILE, 'utf-8'));
        inbox.push({ ts: new Date().toISOString(), from: 'drift-detector-v2', text: 'DRIFT DETECTED on webchat 8080 (score ' + r.score + ') — report: ' + fpath });
        fs.writeFileSync(MAIN_INBOX_FILE, JSON.stringify(inbox, null, 2));
        console.log('🛡 DRIFT DETECTED (score ' + r.score + ') — exchange paused, reported to main');
    } catch (e) { console.warn('⚠️ drift report write failed:', e.message); }
}

async function maybePauseForDrift(text, userPrompt) {
    if (driftGate.mode === 0) return text;
    let thinkText;
    try { thinkText = await getAndClearThinkBuf(); } catch { return text; }
    if (!thinkText || !thinkText.trim()) return text;
    const result = await driftGate.feed(thinkText, userPrompt);
    if (!result.paused) return text;
    await reportDrift({ ...result.gate, verdict: result.verdict, thinkText, userPrompt });
    return DRIFT_PAUSE_TEXT + (result.verdict && result.verdict.reason ? '\n\nJudge: ' + result.verdict.reason : '');
}

async function handleRequest(systemText, userPrompt, toolDefs, onProgress, isAborted, opts = {}) {
    // 09-04 MIN_LANE_GAP: the DS webchat account rate-limits bursts
    // ("Messages too frequent, rate_limit_reached") — pace sends when
    // MIN_LANE_GAP_SECONDS is set (ds-gw drop-in). Global instance gate.
    if (config.laneGapSeconds > 0) {
        const gap = (Number(config.laneGapSeconds) || 0) * 1000;
        const wait = (global.__lastLaneSend || 0) + gap - Date.now();
        if (wait > 0) await sleep(wait);
        global.__lastLaneSend = Date.now();
    }
    // 08-19 (user): TWO MODES — autonomous (execution lane: bare tool calls,
    // no narration) vs user mode (interactive: 💬 narration before tool
    // calls). The executor signals autonomous per request; a process-level
    // AUTONOMOUS=1 env also opts the whole instance in. Default = user mode.
    const autonomous = !!(opts.autonomous || config.autonomous);
    const preamble = config.allowPlainText ? CONV_PREAMBLE : WEBCHAT_PREAMBLE;
    let prompt = `### SYSTEM INSTRUCTION\n${preamble}\n\n`;
    if (systemText) prompt += `${systemText}\n\n`;
    prompt += `### USER MESSAGE\n${userPrompt}\n\n`;
    // 08-19 (user): autonomous (execution lane) = bare tool calls, no
    // narration; user mode = 💬-protocol format with narration.
    prompt += opts.formatText || (autonomous ? AUTONOMOUS_FORMAT : (config.allowPlainText ? CONV_FORMAT : WEBCHAT_FORMAT));
    prompt += continueDirective(userPrompt);
    prompt += greetingDirective(userPrompt);
    prompt += `### RESPONSE\n`;

    if (isAborted?.()) {
        console.log('🔴 client disconnected before request started — skipping');
        return null;
    }

    // Context-handoff accounting (08-13): the tee records the completion
    // REQUEST body size after every send — the true per-request context
    // (DeepSeek's cap is on history + system + tools + message together).
    // lastReqBodyChars is refreshed by the module-level countedSend; the
    // pre-send check fires when the thread is ALREADY near the cap, the
    // round-top check fires when the body GROWS past it mid-tool-loop.
    sendRetriesLeft = 1; // per-request timeout-retry budget for countedSend

    // Pre-send context check: if the LAST recorded request body (the previous
    // request's full history + overhead) is already at/over the threshold,
    // the thread is near DeepSeek's cap — hand off BEFORE sending anything.
    // Fresh threads read 0 here (nothing captured) and never trip this path;
    // the lastHandoffAt grace lets a just-seeded thread (whose body is
    // overhead + doc, possibly ≥ threshold) run its first request. Growth
    // during the request is handled by the round-top check.
    lastReqBodyChars = await getReqBodyChars();
    if (
        config.contextHandoffEnabled &&
        lastReqBodyChars >= config.contextHandoffThreshold &&
        Date.now() - lastHandoffAt > 120000
    ) {
        console.log(`📈 request body already at handoff threshold (${lastReqBodyChars} chars ≥ ${config.contextHandoffThreshold}) — handing off`);
        return runContextHandoff({ toolDefs, onProgress, isAborted, userPrompt, lastToolInfo: null });
    }

    activeHandoffCtx = { toolDefs, onProgress, isAborted, userPrompt, lastToolInfo: null };

    let response = await countedSend(injectMainReplies(prompt), toolDefs);
    // Growth baseline: captured AFTER the first send so a request whose body
    // starts large (fresh seed, big overhead) isn't seen as "grown" by it.
    let requestStartBody = lastReqBodyChars;

    // Harness protocol (08-13): the model interleaves plain-text messages with
    // tool calls — "what I'm about to do" → tool call → result → next call →
    // submit_answer summary. The intent message rides to the client (💬 line)
    // BEFORE the tool executes; a prose-only reply is delivered and the model
    // gets a nudge back so it continues with its tool call; a broken tool-JSON
    // attempt gets a correction — never a raw leak to the client.
    let proseRounds = 0;      // conversation mode: consecutive prose-only replies
    let malformedRounds = 0;  // broken tool-JSON attempts (both modes)
    let formatErrorRounds = 0; // consecutive non-tool plain-text replies (always-tool mode)
    let narrationNudged = false; // strict mode: send_message narration taught once per request
    let narrationLoopRounds = 0; // 08-19: consecutive send_message-only rounds (narration loop guard)
    let emptyAnswerNudged = false; // 08-16: empty submit_answer retried once before the placeholder
    let workCallsMade = 0;      // 08-19: real (non-send_message/non-submit) tool calls executed
    let noWorkNudged = false;   // 08-19: submit-without-work rejected once, then accepted
    let lastToolInfo = null;  // most recent executed call, for the handoff doc

    for (let round = 0; round < config.maxToolRounds; round++) {
        // Client disconnect (interrupt/close) — stop feeding the webchat tab.
        if (isAborted?.()) {
            console.log(`🔴 client disconnected — aborting webchat loop (round ${round + 1})`);
            return null;
        }
        // Context limit crossed (real request-body size) — hand off to a new
        // chat. Growth guard: the body must have grown >8k chars during THIS
        // request — a big-overhead first message on a fresh thread can already
        // sit at/over the threshold and must not hand off without accumulated
        // work (that's the perpetual-handoff trap).
        if (
            config.contextHandoffEnabled &&
            lastReqBodyChars >= config.contextHandoffThreshold &&
            lastReqBodyChars - requestStartBody > 8000
        ) {
            console.log(`📈 context threshold crossed (request body ${lastReqBodyChars} chars ≥ ${config.contextHandoffThreshold}, grew ${lastReqBodyChars - requestStartBody} this request) — handing off`);
            return runContextHandoff({ toolDefs, onProgress, isAborted, userPrompt, lastToolInfo });
        }
        // 08-13 user rule: tool-call size cap — oversized replies (the chat
        // renderer truncates long messages, corrupting the fenced JSON) get
        // a chunking correction instead of executing garbage.
        if (response.length > MAX_TOOL_CALL_CHARS) {
            console.log(`⚠️ tool call too big (${response.length} chars > ${MAX_TOOL_CALL_CHARS}) — TOO BIG error sent`);
            onProgress?.({ type: 'rejected', text: 'tool call too big — submit in chunks' });
            response = await countedSend(TOO_BIG_MSG, toolDefs);
            continue;
        }
        const parsed = parseToolCalls(response);

        if (parsed.toolCalls.length > 0) {
            malformedRounds = 0;
            formatErrorRounds = 0;
            proseRounds = 0;
            const call = parsed.toolCalls[0];
            // 08-19 (user): a real work tool call breaks the narration loop.
            if (call.toolName !== 'send_message' && call.toolName !== SUBMIT_TOOL) {
                narrationLoopRounds = 0;
            }
            // The model's intent message rides ahead of the tool call — the
            // client sees "what I'm about to do" before the 🔧 line.
            if (parsed.prose) {
                onProgress?.({ type: 'text', text: parsed.prose });
            } else if (call.toolName !== SUBMIT_TOOL && call.toolName !== 'send_message') {
                // 08-19 (user): substantive auto-narration — the old template
                // ("Let me run X to inspect and perform the requested task")
                // was literal smartass noise. Describe the ACTUAL action from
                // the call's params instead.
                const ap = call.args || {};
                const autoNarration =
                    call.toolName === 'read_file' ? `Reading ${ap.path ?? ap.file ?? '?'}`
                    : call.toolName === 'write_file' ? `Writing ${ap.path ?? ap.file ?? '?'}`
                    : call.toolName === 'list_dir' ? `Listing ${ap.path ?? ap.dir ?? '.'}`
                    : call.toolName === 'run_bash' ? `Running ${String(ap.command ?? ap.cmd ?? ap.script ?? '').slice(0, 80)}`
                    : call.toolName === 'get_time' ? 'Checking the time'
                    : `Running ${call.toolName}`;
                onProgress?.({ type: 'text', text: autoNarration });
            }

            // 08-20 (audit BUG-15): MULTI-CALL BATCH. The model may emit
            // several tool calls in one message (read a.py, b.py, c.py
            // before editing). Previously only toolCalls[0] ran and the rest
            // were silently dropped — the model re-issued them next turn:
            // 3 round trips at 30-90s each for what one batch answers.
            // Execute ALL work calls (sequential — local tools are fast and
            // write_file/run_bash pairs must not race; the saving is the
            // round trip, not the tools), then send ONE follow-up with every
            // receipt. send_message is narration, submits end the turn —
            // both keep the single-call flow below.
            const _submitNames = [SUBMIT_TOOL, 'submit_message', 'task_complete', 'done'];
            const batchCalls = parsed.toolCalls.filter((c) => c.toolName !== 'send_message' && !_submitNames.includes(c.toolName));
            if (batchCalls.length > 1) {
                const receipts = [];
                for (const bc of batchCalls) {
                    malformedRounds = 0; formatErrorRounds = 0; proseRounds = 0;
                    narrationLoopRounds = 0; // work happened — clear the narration-loop guard
                    onProgress?.({ type: 'tool', name: bc.toolName, args: bc.args });
                    lastToolInfo = { tool: bc.toolName, args: bc.args };
                    if (activeHandoffCtx) activeHandoffCtx.lastToolInfo = lastToolInfo;
                    const br = await executeTool(bc.toolName, bc.args, { threadId: config.webchatUrl || null });
                    workCallsMade += 1;
                    onProgress?.({ type: 'text', text: formatToolResultView(bc, br, 6000, { omitHeader: true }) });
                    receipts.push(formatToolResultView(bc, br, 150000, { forModel: true }));
                }
                response = await countedSend(receipts.join('\n\n') + '\n\n' + TOOL_INSTRUCTIONS, toolDefs);
                continue;
            }

            // 08-13 EVENING (user rule "force it"): a work tool call with NO
            // prose and NO send_message means the model skipped narration —
            // nudge it ONCE per request to send send_message first. (Bounded:
            // one extra round max; the call itself is not lost, the model
            // re-sends it after the send_message.)
            // 08-18 (user): autonomous plan-execution lane (AUTONOMOUS=1) skips
            // the nudge entirely — tool calls are used freely, no wasted 💬.
            if (
                !config.allowPlainText &&
                !autonomous &&
                !parsed.prose &&
                call.toolName !== SUBMIT_TOOL &&
                call.toolName !== 'send_message' &&
                !narrationNudged
            ) {
                narrationNudged = true;
                console.log(`💬 narration nudge (round ${round + 1}) — work call without send_message`);
                response = await countedSend(NARRATION_MSG, toolDefs);
                continue;
            }

            // The model delivered its final answer through submit_answer / submit_message.
            // Accepted unconditionally: ends the tool loop and delivers the final answer.
            const isSubmit = call.toolName === SUBMIT_TOOL || call.toolName === 'submit_message' || call.toolName === 'task_complete' || call.toolName === 'done';
            if (isSubmit) {
                // 08-19 (user): strict mode = tool-calling machine. A final
                // answer with ZERO work tool calls means the model yapped out
                // instead of acting (observed: gemini answered "the tool
                // definitions do not match" without touching read_file).
                // Reject once and order it to work; then accept whatever
                // comes next so a stubborn model can't loop forever.
                if (!config.allowPlainText && workCallsMade === 0 && !noWorkNudged) {
                    noWorkNudged = true;
                    console.log('⚠️ submit_answer with no work tool call — ordering a work call first');
                    onProgress?.({ type: 'rejected', text: 'final answer submitted without performing any tool call' });
                    response = await countedSend(NO_WORK_MSG, toolDefs);
                    continue;
                }
                const answer = cleanWebchatText(call.args?.text ?? call.args?.message ?? call.args?.content ?? call.args?.summary ?? '');
                const final = answer || extractSubmitText(response);
                // 08-16 EMPTY-ANSWER FIX: an empty submit was surfaced verbatim; nudge once for real answer
                if (!final && !emptyAnswerNudged) {
                    emptyAnswerNudged = true;
                    console.log('⚠️ empty submit answer — nudging the model to deliver its real answer');
                    onProgress?.({ type: 'rejected', text: 'your submit was empty — deliver your real final answer in the text field' });
                    response = await countedSend(EMPTY_ANSWER_MSG, toolDefs);
                    continue;
                }
                return await maybePauseForDrift(final || '[webchat model completed the task]', userPrompt);
            }
            if (call.toolName !== 'send_message') {
                onProgress?.({ type: 'tool', name: call.toolName, args: call.args });
            }
            lastToolInfo = { tool: call.toolName, args: call.args };
            if (activeHandoffCtx) activeHandoffCtx.lastToolInfo = lastToolInfo;
            // 08-13 EVENING (user rule): send_message is the JSON-only way to
            // talk to the user — deliver its text to the client as a 'text'
            // progress event (rendered "💬 <text>") instead of running a tool.
            let result;
            if (call.toolName === 'send_message') {
                // 08-19 (user): narration-loop guard — consecutive
                // send_message-only rounds mean the model acknowledges but
                // never acts. Block send_message after 3; abort after 6.
                narrationLoopRounds += 1;
                if (narrationLoopRounds >= 6) {
                    console.log(`⚠️ narration loop — aborting request after ${narrationLoopRounds} consecutive send_message calls`);
                    onProgress?.({ type: 'rejected', text: 'model stuck in narration loop — no work tool call after 6 send_message rounds' });
                    return null;
                }
                if (narrationLoopRounds >= 3) {
                    console.log(`⚠️ narration loop guard (${narrationLoopRounds} consecutive send_message) — blocking send_message`);
                    response = await countedSend(NARRATION_LOOP_MSG, toolDefs);
                    continue;
                }
                const text = String(call.args?.text ?? '');
                if (text) onProgress?.({ type: 'text', text });
                result = { success: true, delivered: true, instruction: 'Message delivered to user. Now proceed with your work tool call (read_file, run_bash, etc.) or deliver final answer via submit_answer.' };
            } else {
                workCallsMade += 1; // 08-19: count for the no-work-submit gate below
                result = await executeTool(call.toolName, call.args, { threadId: config.webchatUrl || null });
                // 08-19 DIAG: log the tool result content the model will see
                // (head + tail) — the gemini lane once looped re-reading the
                // same file instead of executing, and this reveals whether the
                // result actually carried the content the model needed.
                const rs = JSON.stringify(result ?? null);
                console.log(`  ↳ result[${rs.length}] head: ${rs.slice(0, 400).replace(/\n/g, '\\n')}`);
                if (rs.length > 800) console.log(`  ↳ result[${rs.length}] tail: ${rs.slice(-300).replace(/\n/g, '\\n')}`);
            }
            // 08-16 (user): stream a readable receipt to the client — the exact
            // command / file / output, not a bare "🔧 toolname" — so anyone
            // watching the webchat knows what just ran. The tab follow-up
            // below carries the full result (belt-capped) for the model.
            // 08-19 (user): omitHeader — the 🔧 line already showed the call;
            // the receipt must not repeat the command (double-display fix).
            if (call.toolName !== 'send_message') {
                onProgress?.({ type: 'text', text: formatToolResultView(call, result, 6000, { omitHeader: true }) });
            }
            // 08-14 WEDGE ROOT-CAUSE belt: whatever a tool returns, the result
            // message must stay small — a huge read_file output previously
            // ballooned the next prompt to 6.2M chars and wedged the tab.
            // (read_file itself now caps at 200K; the receipt below is capped
            // at 150K and never re-serializes the full result JSON twice.)
            // 08-13 EVENING (user rule): NEVER end the tool loop after a tool
            // call — the model used "next":"done" mid-task and the harness
            // went idle with the task unfinished. The turn ends ONLY when the
            // model sends its final summary (a reply with no tool call). The
            // pause wedge is gone; every tool result continues the loop.
            // NEVER tell the model it's done after a tool result (08-12:
            // "Now give your final answer" made DeepSeek finalize after the
            // FIRST call by yapping a plan). Keep it in tool mode: next tool
            // call, or submit_answer when the task is genuinely complete.
            // 08-16 (user): present the result as a Claude-Code-style receipt
            // instead of the raw "Tool call X returned: json {...}" envelope —
            // the file path + stats, the exact bash command with its output, or
            // a red/green write_file diff. The receipt (150K belt) already
            // carries the full content for read_file/run_bash and the diff for
            // write_file, so NO separate full-result JSON block — that would
            // double the message and re-wedge the tab. send_message needs no
            // receipt: its text was already delivered to the client above.
            const followUp =
                // 08-19 (user, de-lobotomize): forModel=true — this receipt goes
                // into the agent's context, so it MUST carry the real tool output.
                (call.toolName === 'send_message' ? '' : formatToolResultView(call, result, 150000, { forModel: true }) + '\n\n') +
                TOOL_INSTRUCTIONS;
            response = await countedSend(followUp, toolDefs);
            continue;
        }

        // No tool call in this reply. Did it LOOK like a tool attempt?
        // (a "tool": envelope anywhere, or the renderer's json/Copy/Download
        // chrome glued to an opening brace — raw triple quotes, raw newlines,
        // or a truncated brace made the parse fail). Send it back as a
        // correction — never ship the raw row text to the client.
        if (looksLikeBrokenToolJson(response)) {
            if (malformedRounds >= 3) {
                // 08-16 (user): sustained degradation. Three corrections already
                // went back and the model STILL can't emit a parseable tool call.
                // The old code fell through to the FORMAT_ERROR loop and ground
                // to round 40 (~8 min of churn) for a model that was never going
                // to recover. Bail NOW with a clear marker so the client can
                // resume from the last completed tool instead of waiting.
                console.log(`⚠️ 3+ consecutive malformed tool replies (round ${round + 1}) — bailing early. RAW: ${String(response).slice(0, 2000)}`);
                onProgress?.({ type: 'rejected', text: 'webchat model degraded — malformed tool calls; aborting this round' });
                return exhaustedMarker('[⚠️ webchat model degraded mid-task (malformed tool calls) — resume from the last completed tool call and retry] ', response);
            }
            malformedRounds++;
            console.log(`⚠️ malformed tool JSON (round ${round + 1}) — correction sent. RAW: ${String(response).slice(0, 2000)}`);
            onProgress?.({ type: 'rejected', text: 'malformed tool JSON — correction sent' });
            response = await countedSend(MALFORMED_MSG, toolDefs);
            continue;
        }

        // CONVERSATION MODE (ALLOW_PLAIN_TEXT=true): personal threads
        // reply directly in natural text / markdown without artificial tool nudges.
        if (config.allowPlainText) {
            const prose = cleanWebchatText(cleanProse(response));
            return await maybePauseForDrift(finalAnswerFor(prose), userPrompt);
        }

        // Always-tool mode: ANY plain-text reply is a format error, yap or not.
        // Progress reports get a sharper correction: DeepSeek's chat behavior is
        // to pause after tool work and summarize ("I added X, next I will Y") —
        // the generic format message alone doesn't break that habit (2nd-session
        // transcript 08-12: yapped a progress report after write_file AND after
        // "continue").
        if (round < config.maxToolRounds - 1) {
            const yap = looksLikeYap(response);
            if (++formatErrorRounds >= (config.maxFormatErrorRounds || 4)) {
                // 08-16 (user): same degradation as the malformed bail — 4+
                // plain-text replies in a row means the model is stuck, not
                // "one more nudge away". Stop grinding to round 40.
                console.log(`⚠️ 4+ consecutive plain-text replies (round ${round + 1}) — bailing early. RAW: ${String(response).slice(0, 2000)}`);
                onProgress?.({ type: 'rejected', text: 'webchat model stuck replying without tool calls — aborting this round' });
                return exhaustedMarker('[⚠️ webchat model kept replying without tool-call JSON (4+ rounds) — resume from the last completed tool call and retry] ', response);
            }
            console.log(`⚠️ webchat replied without tool JSON (round ${round + 1})${yap ? ' [progress-report yap]' : ''} — sending FORMAT ERROR`);
            onProgress?.({ type: 'rejected', text: yap ? 'plain-text progress report — rejected, demanding the next tool call' : 'plain-text reply — format error sent, demanding fenced tool JSON' });
            response = await countedSend(yap ? YAP_ERROR_MSG : FORMAT_ERROR_MSG, toolDefs);
            continue;
        }
        // Corrections exhausted — surface a SHORT marker. The model's raw
        // reply after context overflow can be a multi-KB echo of its own
        // prompt (08-12: ~30KB dumped into the exhausted marker) — never
        // ship that to the client.
        return exhaustedMarker('[⚠️ webchat model kept replying without tool-call JSON] ', response);
    }

    // Round budget exhausted without a submit_answer. Cap what the client sees
    // (08-12: the degraded model echoed the entire system prompt here).
    console.log(`⚠️ round budget exhausted (${config.maxToolRounds}) without submit_answer. RAW: ${String(response).slice(0, 2000)}`);
    return exhaustedMarker('[⚠️ webchat model did not submit a final answer within the round budget] ', response);
}

// The exhausted-path markers must never carry a raw broken JSON envelope
// (08-13: truncation used to leave the client staring at half a tool call).
function exhaustedMarker(prefix, response) {
    if (looksLikeBrokenToolJson(response)) return prefix + '(malformed tool call — dropped, not shown)';
    return prefix + truncateForClient(response);
}

// Conversation-mode final answer: strip the renderer chrome and never let a
// broken tool envelope through as text.
function finalAnswerFor(text) {
    if (looksLikeBrokenToolJson(text)) {
        return '[⚠️ webchat model kept sending malformed tool calls — please retry the request]';
    }
    return text || '[webchat model gave no reply]';
}

// Did this reply LOOK like a tool-call attempt that failed to parse? Such a
// reply is always a JSON document: an opening brace, optionally behind a fence
// label or the renderer's json/Copy/Download chrome. It goes back to the model
// as a correction — never to the client as raw text.
// 08-16: the old unanchored /"tool":/ clause flagged ANY text that merely
// mentioned `"tool":` — including gemini's plain-prose narrations that quote
// the format ("use {"tool":"run_bash",...}"). The harness then dropped good
// narration as "malformed", sent corrections, and burned the whole round
// budget. Only brace-leading replies are tool attempts now.
function looksLikeBrokenToolJson(text) {
    if (typeof text !== 'string') return false;
    // Head-anchored: the reply IS the envelope (bare / fenced / renderer chrome).
    if (/^\s*(?:json|txt|text|python|bash|shell)?\s*(?:Copy\s*)?(?:Download\s*)?\{/i.test(text)) return true;
    // 08-19 (user): user-mode replies narrate FIRST ("💬 ...") then emit the
    // tool envelope at a line start — a ^-anchored check sails past the
    // broken JSON, falls into the plain-text path, and ENDS the turn with
    // raw JSON as the final answer. Line-anchored: a `{` at line start
    // (optionally behind a fence/label) that carries a "tool" key, when
    // parseToolCalls already failed on the whole reply, is a broken attempt —
    // correct it, never ship it. (Narration that merely QUOTES {"tool":...}
    // inline mid-sentence doesn't match: the brace must start the line.)
    return /\n\s*(?:```\s*)?(?:json|txt|text|python|bash|shell\s*)?\s*(?:Copy\s*)?(?:Download\s*)?\{[\s\S]*"tool"\s*:\s*"/i.test(text);
}

// Cap client-visible markers at ~1.5KB — after context overflow the model's
// raw reply can be a huge echo of its own prompt (08-12: ~30KB of system-prompt
// text shipped inside the exhausted marker to the 2nd session's client).
function truncateForClient(text) {
    if (typeof text !== 'string' || text.length <= 1500) return text;
    return text.slice(0, 1500) + `\n…(truncated — raw reply was ${text.length} chars)`;
}

// Harness protocol (08-13): the model sent a prose-only reply. Deliver it,
// then nudge it back into tool mode — the user's exact ask: "it sends the
// message, then a message back so it can send the tool call".
const NARRATION_MSG =
    '### NARRATION REQUIRED (user rule 08-13 EVENING)\n' +
    'Your last tool call was NOT preceded by a send_message. Before ANY work tool call you MUST send ' +
    'send_message first: one short 💬 line with what you are thinking and what the tool call you are about ' +
    'to make does and why (delivered to the user verbatim). Reply NOW with that send_message call. ' +
    'Then continue with your work tool call as usual.';

// 08-19 (user: "make everything a tool call... so it gets into the habit of
// using tool calls"): the model ACKNOWLEDGES via send_message but never
// follows up with a work tool call — the harness burned all 40 rounds on
// narration. Guard: after 3 consecutive send_message-only rounds, send_message
// is blocked for the rest of the request; a 6th consecutive one aborts.
const NARRATION_LOOP_MSG =
    '### NARRATION-LOOP GUARD (hard, user rule 08-19)\n' +
    'You have sent several consecutive send_message calls WITHOUT doing any work. That is a loop, not ' +
    'a task. send_message is now BLOCKED for the rest of this request — your next reply MUST be a ' +
    'work tool call (read_file, run_bash, write_file, or another tool from the list) that ACTUALLY ' +
    'performs the task, or a fenced submit_answer if the task is genuinely complete. ' +
    'No send_message. No acknowledgement. DO THE WORK.';

const NO_WORK_MSG =
    '### NO WORK DONE (hard, user rule 08-19)\n' +
    'Your final answer was submitted WITHOUT performing a single tool call. This is a tool-calling ' +
    'harness — you act through tools, you do not talk about acting. Perform at least ONE real work ' +
    'tool call (read_file, run_bash, write_file, etc.) that carries the task forward, then submit ' +
    'the ACTUAL result via submit_answer. If a tool failed, call it correctly — do not summarize ' +
    'your inability to call it.';

const EMPTY_ANSWER_MSG =
    '### EMPTY ANSWER (08-16)\n' +
    'Your submit_answer had an EMPTY text field — it reached the user as nothing. ' +
    'Deliver your real final answer now: a fenced submit_answer with the actual ' +
    'content in the text field. If you have not finished the task, continue working ' +
    'with your tools until it is done, then submit the full final answer.';

const PROSE_NUDGE =
    'Your message was delivered to the user. Continue the task: send your NEXT tool call JSON, fenced as ```json ... ``` — ' +
    'or a fenced submit_answer if the entire task is done and verified. ' +
    '(You may send one plain-text progress line before it.)';

// Malformed tool-JSON attempt (raw triple quotes/newlines in string values,
// unescaped quotes, truncated braces). Correct with the specific rule the
// chat model keeps violating — never leak the raw row text to the client.
const MALFORMED_MSG =
    '### MALFORMED TOOL CALL\n' +
    'Your previous reply contained a tool-call attempt that was NOT valid JSON and could not be parsed ' +
    '(raw newlines or triple quotes inside string values, unescaped quotes, or a missing closing brace). ' +
    'Resend it as a single valid fenced JSON object. Rules: escape " as \\", backslashes as \\\\, newlines as \\n. ' +
    'NEVER use triple quotes (""") inside a JSON string — especially in write_file content; file content with ' +
    'quotes or newlines must be escaped, not triple-quoted. ' +
    'If a command argument is long or quote-heavy (python3 -c "..." with embedded quotes), do NOT inline it: ' +
    'write a temporary script file with write_file (e.g. /tmp/step.py), then run it via run_bash. One tool call per reply:\n' +
    '```json\n{"tool":"<name>","params":{...}}\n```' +
    '\nDO NOT answer the user\'s request in plain text. The request requires tool work — if you do not know where the ' +
    'work lives, run list_dir on the absolute path from the user\'s message first. Resubmit your tool call NOW.';

const FORMAT_ERROR_MSG =
    '### FORMAT ERROR\n' +
    'Your previous response was NOT in the required format: you sent plain text instead of a fenced tool call JSON object. ' +
    'ALWAYS respond with exactly one JSON object wrapped in a markdown code fence, like this:\n' +
    '```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'The fence is MANDATORY — without it this chat renders your backticks as formatting and corrupts your content. ' +
    'If the task is complete, use a fenced {"tool":"submit_answer","params":{"text":"your final answer"}}. ' +
    'If you wrote an implementation as prose, that is NOT the work: re-emit it as write_file tool calls instead. ' +
    'No prose. No markdown. No questions. No plans. Nothing else.';

// 08-20 (audit BUG-15): the turn-continuation instruction appended to every
// tool receipt. Extracted to a const because multi-call batches append it
// once after N receipts instead of once per call.
const TOOL_INSTRUCTIONS = (config?.allowPlainText
    ? 'You MUST send ONE plain-text 💬 line before your next tool call (your thinking + what the ' +
      'tool is about to do and why — delivered to the user verbatim; user rule 08-13), then your ' +
      'NEXT tool call JSON, fenced. ' +
      'When the entire task is done AND verified, reply with a fenced submit_answer carrying your final summary ' +
      'message. Keep progress lines to one sentence — the work is the tool calls. ' +
      'Verify with run_bash: syntax checks, import tests, dependency checks, and the project tests. ' +
      'Do not claim completion for work you have not verified actually runs. ' +
      'Large files: read_file results are ALWAYS capped at 200K chars (truncated:true + totalLength) — page through with maxLength + offset until truncated is false. ' +
      'The next step: fenced {"tool":"<name>","params":{...}}.'
    : 'The full tool list is below. The task is NOT complete until every part is done AND verified — do not stop now. ' +
      'Reply with exactly ONE tool call per message, fenced as ```json ... ```. To speak to the user, ' +
      'call send_message with your one-line 💬 (what you are thinking and about to do) — that is how ' +
      'your progress reaches the user; never write plain text outside the JSON fence. ' +
      'Respond with exactly ONE of these two, and nothing else: ' +
      '(a) your NEXT tool call JSON (send_message or a work tool), fenced as ```json ... ```; ' +
      '(b) submit_answer, fenced, IF AND ONLY IF the entire task is done and verified. ' +
      'Continue the work: inspect, modify, VERIFY. Verify with run_bash — run syntax checks, import tests, ' +
      'dependency checks (pip), and the project tests. Do not claim completion for work you have not ' +
      'verified actually runs. ' +
      'Large files: read_file results are ALWAYS capped at 200K chars (truncated:true + totalLength) — page through with maxLength + offset until truncated is false. ' +
      'The next step: fenced {"tool":"<name>","params":{...}}.');

// Progress-report yap: DeepSeek pauses after tool work and writes a status
// update ("I added X, next I will Y") instead of the next tool call. The
// generic format message doesn't break that habit — this one does.
const YAP_PATTERNS = [
    'next step', 'next steps', 'will now', 'i will', 'now supports',
    'i added', "i've added", 'i have added', 'i implemented', 'i have implemented',
    'i integrated', 'i have integrated', 'i created', 'i have created',
    'i wrote', 'i have written', 'i wired', 'i built', 'i have built',
    'progress', 'as a result', 'continued', 'let me', 'summary of',
    'here is what', 'here is a', 'now i', 'to do this', 'overview',
];

function looksLikeYap(text) {
    const t = (text || '').toLowerCase();
    return YAP_PATTERNS.some((p) => t.includes(p));
}

const YAP_ERROR_MSG =
    '### FORMAT ERROR — progress reports are NEVER accepted\n' +
    'Your last message was a plain-text progress report or summary. Nobody reads those — your only output ' +
    'channel is tool calls and submit_answer. "I added X, next I will Y" is plain text and is rejected, ' +
    'every time. The task is not done until every part is done and verified. Respond NOW with exactly one ' +
    'fenced JSON: either your next tool call (```json {"tool":"<name>","params":{...}} ```) or, if and only if ' +
    'the entire task is complete and verified, submit_answer. Do not narrate. Do it.';

// ──────────────────────────────────────────────────────
// CONTEXT HANDOFF (08-13)
//    Rough threshold: chars/4 ≈ tokens. Every sendPrompt's FULL built prompt
//    (tool section included) plus every model reply is counted; when the
//    running request's total crosses the threshold, the tool loop stops, the
//    model writes a handoff document, the tab opens a NEW chat, and the
//    document goes in as the first message. Pins (chat.js + supervisor) are
//    swapped so every respawn path follows the new thread.
// ──────────────────────────────────────────────────────
function estimateTokens(s) {
    return Math.ceil(String(s).length / 4);
}

// One-off measurement of the per-send tool section (schema text + reminder),
// counted on every round because buildFullPrompt re-includes it each time.
const TOOL_SECTION_TOKENS = (() => {
    try { return estimateTokens(buildFullPrompt('', buildExecutableToolDefs())); } catch { return 1000; }
})();

function buildHandoffPrompt(lastToolInfo) {
    return '### CONTEXT LIMIT — HANDOFF MODE\n' +
        'The conversation has reached its context-window threshold and cannot continue. STOP the current task.\n' +
        (lastToolInfo
            ? 'Your most recent work was: ' + JSON.stringify(lastToolInfo).slice(0, 1500) + '\n'
            : '') +
        'Write a COMPLETE handoff document so a brand-new chat can continue seamlessly. Use the write_file tool ' +
        `with EXACTLY this path: ${config.handoffFile}\n` +
        'The document (markdown) must contain:\n' +
        '1. The current task and exactly how far it has progressed\n' +
        '2. Every file created or changed so far (path + one line on what it does)\n' +
        '3. Key decisions and why\n' +
        '4. Commands run and their important results\n' +
        '5. The remaining steps, in order\n' +
        '6. Anything you were mid-way through\n' +
        'Then reply with a fenced submit_answer whose text is a one-line confirmation: "Handoff written".';
}

// Ask the model for the handoff document (≤6 rounds: write_file the doc, then
// submit_answer). Returns the document CONTENT, or null if the client aborted.
// 08-13 HARDENING: sends go through countedSend (rate-limit spacing + body
// refresh), and the whole flow is wrapped — if the thread hits the hard cap
// MID-document (context_length_exceeded on a doc write), the caller's
// fallback summary takes over instead of a 500.
async function runHandoff({ toolDefs, onProgress, isAborted, userPrompt, lastToolInfo }) {
    // handoffPath is read AFTER the try/catch (fallback path) — it must live
    // at function scope, not inside the try (08-13: ReferenceError when the
    // doc flow failed and the fallback read loop ran).
    let handoffPath = null;
    try {
        let response = await countedSend(buildHandoffPrompt(lastToolInfo), toolDefs);
        for (let round = 0; round < 6; round++) {
            if (isAborted?.()) return null;
            // 08-13 size cap (see MAX_TOOL_CALL_CHARS): the handoff doc is the
            // classic oversized-write target — chunk it instead of mangling it.
            if (response.length > MAX_TOOL_CALL_CHARS) {
                console.log(`⚠️ handoff tool call too big (${response.length} chars) — chunking instruction sent`);
                response = await countedSend(TOO_BIG_MSG, toolDefs);
                continue;
            }
            const parsed = parseToolCalls(response);
            if (parsed.toolCalls.length) {
                const call = parsed.toolCalls[0];
                if (call.toolName === SUBMIT_TOOL) break;
                onProgress?.({ type: 'tool', name: call.toolName, args: call.args });
                const result = await executeTool(call.toolName, call.args, { threadId: config.webchatUrl || null });
                const p = String(call.args?.path || '');
                if (call.toolName === 'write_file' && /handoff/i.test(p)) handoffPath = p;
                response = await countedSend(
                    formatToolResultView(call, result, 6000) + '\n\n' +
                    'The task is: write the handoff document via write_file (if you have not yet) at EXACTLY ' +
                    `${config.handoffFile}, then reply with a fenced submit_answer — one line confirming the path.`,
                    toolDefs
                );
                continue;
            }
            if (looksLikeBrokenToolJson(response) && round < 2) {
                response = await countedSend(MALFORMED_MSG, toolDefs);
                continue;
            }
            if (round < 2) {
                response = await countedSend(PROSE_NUDGE, toolDefs);
                continue;
            }
            break;
        }
    } catch (e) {
        // Thread hit the hard cap mid-document (or the page died) — the model
        // couldn't finish the doc; the fallback summary below still carries
        // the request + last tool work into the new chat.
        console.log(`⚠️ handoff doc flow failed (${String(e.message).slice(0, 200)}) — using fallback summary`);
    }

    // Read the document back (the model's tracked path first, the configured
    // path second; fall back to a gateway-built summary). Freshness gate:
    // the configured file may hold an OLD handoff from a previous swap —
    // only accept it if written within the last 5 minutes by THIS flow.
    let content = '';
    for (const p of [handoffPath, config.handoffFile]) {
        if (!p) continue;
        try {
            const st = fs.statSync(p);
            if (Date.now() - st.mtimeMs > 300000) continue; // stale doc — skip
            content = fs.readFileSync(p, 'utf8');
        } catch { /* try next */ }
        if (content && content.trim().length > 20) break;
        content = '';
    }
    if (!content.trim()) {
        // Gateway-built summary (08-13): scrapes the rendered thread (the
        // "look at chat history" requirement) so the fresh chat still carries
        // what was being discussed even when the model couldn't write a doc.
        let recent = '';
        try {
            recent = String(
                (await getPage().evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')) || ''
            ).slice(-3000);
        } catch { /* page busy — summary without the scrape */ }
        content = '# Context handoff (automatic)\n\n' +
            'The webchat reached its context limit before the model produced a full document.\n\n' +
            `- User's request: ${(userPrompt || '').slice(0, 400)}\n` +
            `- Last tool work: ${lastToolInfo ? JSON.stringify(lastToolInfo).slice(0, 1500) : 'none recorded'}\n\n` +
            (recent ? `- Recent thread content (scraped from the old chat):\n\n${recent}\n\n` : '') +
            '_(auto-generated by the gateway context-handoff)_\n';
    }
    return content;
}

// Full handoff sequence: doc → fresh chat → seed → re-pin this instance →
// persist pins for respawns. Returns the client-facing summary (or null).
async function runContextHandoff({ toolDefs, onProgress, isAborted, userPrompt, lastToolInfo }) {
    // Grace stamped FIRST: from here until 2 min after the swap, any
    // context-length error inside the doc flow rethrows into runHandoff's
    // fallback instead of recursing into another handoff on the same full
    // thread (the error path in countedSend checks this timestamp).
    lastHandoffAt = Date.now();
    onProgress?.({ type: 'text', text: '⚠️ context threshold reached — generating handoff document' });
    const content = await runHandoff({ toolDefs, onProgress, isAborted, userPrompt, lastToolInfo });
    if (content === null) return null;

    // Old thread id BEFORE navigating away (the tab's URL is the only source).
    const oldUrl = getPage()?.url() || config.webchatUrl;
    const oldId = (oldUrl.match(/\/a\/chat\/s\/([0-9a-f-]+)/) || [])[1] || config.tabUrlSubstring;

    onProgress?.({ type: 'text', text: '💬 handoff written — opening a new chat' });
    const { url: newUrl } = await openNewChatAndSeed(content);
    const newId = (newUrl.match(/\/a\/chat\/s\/([0-9a-f-]+)/) || [])[1];

    // 08-13 STALE-BODY FIX: the tee's stream buffer and page-side counter
    // now describe the OLD thread (its last body was at/over threshold). Read
    // the SEED request's body first (that IS the fresh thread's true size),
    // then wipe the page-side state so stale entries/counters can't re-trigger
    // this handoff — and stamp the grace so the fresh thread's first request
    // is never refused for a body it legitimately has.
    lastReqBodyChars = await getReqBodyChars();
    await resetTeeForHandoff();
    lastHandoffAt = Date.now();

    // Re-target THIS instance: the next request lands on the new thread.
    if (newId) config.tabUrlSubstring = newId;
    config.webchatUrl = newUrl;
    console.log(`🔁 Thread swap: ${oldId} → ${newUrl}`);

    // Persist the swap for respawns (chat.js + the supervisor's pin line).
    const changed = persistThreadSwap(oldId, newId, newUrl);
    if (changed.length) onProgress?.({ type: 'text', text: `💬 swap persisted (${changed.join(', ')})` });

    return 'Context limit reached — the conversation was handed off to a new chat automatically.\n\n' +
        `- Handoff document: ${config.handoffFile}\n` +
        `- New thread: ${newUrl}\n` +
        `- New thread id: ${newId || 'unknown'}\n` +
        `- Handoff sent as the new chat's first message: yes\n` +
        (changed.length ? `- Respawn pins updated: ${changed.join(', ')}\n` : '') +
        '\nContinue the conversation normally — the new chat received the full handoff.';
}

// ── Persist a thread swap so respawns follow the new chat ──
// chat.js (bare-start default) and the supervisor's WEBCHART_URL / TAB_URL_SUBSTRING
// pins (env-override instances). Only lines referencing the OLD thread id are
// touched — a scratch/test instance can never move the live pins. The supervisor
// parses its script once at start, so it is restarted (kill → verify → relaunch →
// verify) for the new pin to take effect; ensure() is idempotent and the gap is ~2s.
function persistThreadSwap(oldId, newId, newUrl) {
    if (!oldId || !newId || !newUrl) return [];
    const supervisor = '/home/roni/Roni_Workspace/oculus/scripts/stack_supervisor.sh';
    const chatJs = path.join(__dirname, 'chat.js');
    const changed = [];
    try {
        const sv = fs.readFileSync(supervisor, 'utf8');
        if (sv.includes(oldId) || sv.includes(oldId.slice(0, 8))) {
            // 08-13: the supervisor pins use the 8-char id PREFIX for
            // TAB_URL_SUBSTRING (TAB_URL_SUBSTRING=51455c98) while oldId is
            // the full UUID — the full-id split never matched, so the
            // substring pin went stale after handoffs (8082's pin died this
            // way 08-13). Replace both forms with the new 8-char prefix.
            // 08-15 BUGFIX: oldId can ALSO be the 8-char prefix itself (the
            // expert-swap path passes config.tabUrlSubstring = env pin), so
            // the WEBCHAT_URL split left the old uuid tail glued to the new
            // URL (feb229fa-...-6a26-4835-acc2 corruption, pinned a dead
            // thread, every 8080 send after it went to a fresh empty chat).
            // Regex on the prefix + any uuid tail for BOTH oldId forms.
            const old8 = oldId.slice(0, 8), new8 = newId.slice(0, 8);
            fs.writeFileSync(supervisor, sv
                .replace(new RegExp('WEBCHAT_URL=https://chat\\.deepseek\\.com/a/chat/s/' + old8 + '[0-9a-f-]*'), 'WEBCHAT_URL=' + newUrl)
                .split('TAB_URL_SUBSTRING=' + oldId).join('TAB_URL_SUBSTRING=' + new8)
                .split('TAB_URL_SUBSTRING=' + old8).join('TAB_URL_SUBSTRING=' + new8));
            changed.push('stack_supervisor.sh');
            console.log(`📝 supervisor pin: ${oldId} → ${newId}`);
        }
    } catch (e) {
        console.warn('⚠️ supervisor pin update failed:', e.message);
    }
    try {
        const cj = fs.readFileSync(chatJs, 'utf8');
        if (cj.includes(oldId) || cj.includes(oldId.slice(0, 8))) {
            // same prefix-vs-full-uuid fix as the supervisor pin above
            fs.writeFileSync(chatJs, cj.replace(
                new RegExp('https://chat\\.deepseek\\.com/a/chat/s/' + oldId.slice(0, 8) + '[0-9a-f-]*'),
                newUrl));
            changed.push('chat.js');
            console.log(`📝 chat.js pin: ${oldId} → ${newId}`);
        }
    } catch (e) {
        console.warn('⚠️ chat.js pin update failed:', e.message);
    }
    if (changed.includes('stack_supervisor.sh')) restartSupervisor();
    return changed;
}

function restartSupervisor() {
    // Anchored pattern (self-match trap): node's own cmdline is "node
    // server.js", and pkill excludes itself — nothing can match the pattern
    // but the supervisor process(es).
    try {
        spawnSync('pkill', ['-f', 'stack_supervisor[.]sh']);
        for (let w = 0; w < 10; w++) {
            const alive = spawnSync('pgrep', ['-f', 'stack_supervisor[.]sh']);
            if (alive.status !== 0) break; // no match → down
            spawnSync('sleep', ['0.5']);
        }
    } catch (e) {
        console.warn('⚠️ supervisor restart (kill) failed:', e.message);
        return;
    }
    const launch = () => {
        // 08-13: log to the supervisor's own file — stdio:'ignore' spawned a
        // SILENT supervisor (pid 10652) whose loop failures were invisible.
        const child = spawn('bash', ['-c', 'bash /home/roni/Roni_Workspace/oculus/scripts/stack_supervisor.sh >> /tmp/stack_supervisor.log 2>&1'], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        setTimeout(() => {
            const up = spawnSync('pgrep', ['-f', 'stack_supervisor[.]sh']);
            if (up.status !== 0) {
                console.warn('⚠️ supervisor did not come up — relaunching once');
                launch();
            } else {
                console.log('🔄 supervisor restarted — new thread pin live');
            }
        }, 2500);
    };
    launch();
}

// ──────────────────────────────────────────────────────
// ENDPOINTS
// ──────────────────────────────────────────────────────
app.get('/status', async (req, res) => {
    let connected = false;
    try {
        connected = await isConnected();
    } catch (e) {
        console.log('⚠️  /status probe failed:', e.message);
    }
    res.json({
        status: 'online',
        connected,
        webchatUrl: config.webchatUrl,
        tools: getToolDefinitions().length,
        contextHandoff: {
            enabled: config.contextHandoffEnabled,
            threshold: config.contextHandoffThreshold,
            handoffFile: config.handoffFile,
        },
        timestamp: new Date().toISOString(),
    });
});

// 09-03 DIAG: dump the live tab text so the chat bubbles can be inspected
// (why do worker-shaped requests read "Hello! I am ready..." let's SEE the DOM).
app.get('/debug/dump', async (req, res) => {
    try {
        const p = getPage();
        if (!p) return res.json({ ok: false, error: 'no page' });
        const txt = await p.evaluate(() => {
            const el = document.body;
            return el ? el.innerText.slice(0, 6000) : '';
        }).catch((e) => 'EVAL_ERR ' + e.message);
        const shot = await p.screenshot({ encoding: 'base64', type: 'png' }).catch(() => '');
        res.json({ ok: true, url: p.url(), text: txt, shot: shot ? shot.length : 0 });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message).slice(0, 300) });
    }
});

// 09-03 DIAG: run a JS snippet in the live tab (login rescue).
app.post('/debug/eval', async (req, res) => {
    try {
        const p = getPage();
        if (!p) return res.json({ ok: false, error: 'no page' });
        const code = String((req.body || {}).code || '').slice(0, 20000);
        const out = await p.evaluate(code).catch((e) => ({ __err: String(e.message).slice(0, 200) }));
        res.json({ ok: true, out });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message).slice(0, 300) });
    }
});

app.get('/tools', (req, res) => {
    res.json(getToolDefinitions());
});

// 08-19 (user): /newchat — the /newchat slash command in Claude Code curls
// this to start a brand-new conversation in the controlled browser tab
// (the old thread survives server-side; the tab navigates to a fresh chat).
app.post('/v1/newchat', async (req, res) => {
    try {
        const p = await openNewChat();
        res.json({ ok: true, url: p.url(), message: 'New chat started in the webchat tab' });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message).slice(0, 300) });
    }
});

// 08-24 (user): resume a CAPTURED thread — navigate the pinned tab back to a
// saved chat URL so the next audit pass retains its context. /newchat always
// navigates the tab to a fresh chat and lanes serve many personas, so "resume"
// is an explicit goto; the client captures the thread URL via /connect after a
// send and POSTs it back here (body: {url} or {id}).
function buildThreadUrl(idOrUrl) {
    const s = String(idOrUrl || '').trim();
    if (!s) return '';
    if (/^https?:\/\//.test(s)) return s;
    try {
        const host = new URL(config.webchatUrl).host;
        const base = config.webchatUrl.replace(/\/+$/, '');
        if (host.includes('deepseek')) return `${base}/a/chat/s/${s}`;
        // gemini / other webchats: thread URLs are origin/app/<id> (or /app/c/<id>)
        if (/^c\//.test(s)) return `${base}/app/${s}`;
        return `${base}/${s}`;
    } catch (e) {
        return '';
    }
}

app.post('/v1/thread', async (req, res) => {
    try {
        const body = req.body || {};
        const target = typeof body.url === 'string'
            ? body.url.trim()
            : buildThreadUrl(typeof body.id === 'string' ? body.id : '');
        if (!target) {
            return res.status(400).json({ ok: false, error: 'url or id required' });
        }
        const p = await reopenThread(target);
        res.json({ ok: true, url: p.url(), message: 'Tab navigated to thread' });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message).slice(0, 300) });
    }
});

// 08-14 OMNIROUTE SLOT (lazy-start feel): the omniroute_watchdog keeps
// OmniRoute (20128) alive but its dev compile takes minutes after a death.
// If the target is down when a request arrives, wait for the watchdog to
// bring it back before proxying. Race-free: we never spawn it ourselves
// (the watchdog owns that — a second spawner caused the 08-06 restart loop).
async function ensureRouteUp(target) {
    if (!target.includes(':20128')) return;
    // probe the OpenAI models listing, whether the route target is a bare
    // host (http://127.0.0.1:20128) or already carries /api/v1
    const probe = `${target.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1/models`;
    for (let i = 0; i < 18; i++) { // up to ~90s — the watchdog owns respawns
        try {
            const r = await fetch(probe, {
                method: 'GET',
                signal: AbortSignal.timeout(3000),
            });
            if (r.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}

app.get('/v1/models', (req, res) => {
    // 08-14 GATEWAY PICKER: Claude Code's model discovery
    // (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1) only keeps ids
    // containing 'claude'/'anthropic' (v2.1.223+), so advertise
    // claude/-prefixed aliases; the /v1/messages dispatch strips the
    // prefix and routes on the rest (keys must match WEBCHAT_ROUTES /
    // isWebchatModel exactly — 'deepseek webchat' keeps its space).
    const gatewayRows = [
        { id: 'claude/deepseek-v4-flash', display_name: 'V4 Flash (paid API)' },
        { id: 'claude/deepseek webchat', display_name: 'DeepSeek Webchat' },
        { id: 'claude/gemini webchat', display_name: 'Gemini Webchat' },
        { id: 'claude/qwen webchat', display_name: 'Qwen Webchat' },
        { id: 'claude/kimi webchat', display_name: 'Kimi Webchat' },
        { id: 'claude/omniroute', display_name: 'OmniRoute' },
    ];
    res.json({
        object: 'list',
        data: [
            ...gatewayRows.map((r) => ({ ...r, object: 'model', owned_by: 'webchat-api' })),
            { id: config.modelName, object: 'model', owned_by: 'webchat-api' },
            { id: 'deepseek-v4-flash', object: 'model', owned_by: 'upstream-proxy' },
        ],
    });
});

// ── OpenAI-compatible chat completions ──
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, tools, model, stream } = req.body || {};
        // 08-16 PREFIX FIX: mirror /v1/messages — strip the claude/ picker
        // alias before routing, else 'claude/deepseek webchat' failed
        // isWebchatModel and fell through to the paid proxy (400 for a free
        // tab, or silent paid spend) instead of driving the webchat.
        const routedModel = String(model || '').replace(/^claude\//, '');
        const routedBody = routedModel !== model ? { ...req.body, model: routedModel } : req.body;
        if (WEBCHAT_ROUTES[routedModel]) {
            await ensureRouteUp(WEBCHAT_ROUTES[routedModel]);
            const targetBody =
                routedModel === 'omniroute'
                    ? { ...routedBody, model: 'auto/best-coding' }
                    : routedModel.startsWith('gemini')
                        ? { ...routedBody, model: 'gemini 3.7 flash webchat' }
                        : routedBody;
            return proxyTo(req, res, WEBCHAT_ROUTES[routedModel], '/chat/completions', targetBody);
        }
        if (!isWebchatModel(routedBody)) {
            // 08-19 COST SLASH: no silent paid fallthrough. The gateway used to
            // proxy any non-webchat model to the paid DeepSeek API — that is the
            // $97/mo burn. Default: fast local 400. Opt in explicitly.
            if (process.env.ALLOW_PAID_UPSTREAM === '1') {
                return proxyTo(req, res, UPSTREAM_OPENAI.base, '/chat/completions', routedBody);
            }
            console.log(`⛔ paid-upstream rejected (openai route): model=${String(routedBody?.model).slice(0, 80)}`);
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_model',
                    message: `paid upstream disabled — model "${String(routedBody?.model).slice(0, 80)}" is not the webchat model`,
                },
            });
        }
        if (stream) console.log('🡆 streaming chat.completion chunk (SSE)');

        if (!(await isConnected()) && !process.env.TEST_FAKE_RESPONSE) {
            try {
                await ensureConnected(); // lazy connect: attach on first request
            } catch (e) {
                console.log('⚠️ 503: connect failed:', e.message);
                return res.status(503).json({
                    error: `Webchat not connected: ${e.message} — run with HEADLESS=false, log in, then POST /connect`,
                });
            }
        }

        const systemMessage = (messages || []).find((m) => m.role === 'system');
        const userMessage = [...(messages || [])].reverse().find((m) => m.role === 'user');
        const prompt =
            typeof userMessage?.content === 'string'
                ? userMessage.content
                : JSON.stringify(userMessage?.content ?? '');

        // Same greeting short-circuit as /v1/messages (user mode only).
        const isPureGreeting =
            config.allowPlainText &&
            /^\s*(?:hi+|hello|hey+|yo+|sup|howdy|good\s*(?:morning|afternoon|evening)|whats? up|how(?:'s| is| are)\s+(?:it going|you))[\s!.,?~]*$/i.test(prompt);
        const toolDefs = isPureGreeting ? [] : buildExecutableToolDefs();

        const text = await enqueue(() =>
            handleRequest(systemMessage?.content || '', prompt, toolDefs, undefined, undefined,
                { autonomous: req.body?.autonomous === true || req.headers['x-autonomous'] === '1' })
        );

        const completion = {
            id: 'chatcmpl_' + Math.random().toString(36).slice(2, 12),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || config.modelName,
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: text },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
        };
        // 09-03 SSE (pi/shannon always stream:true): emit one chat.completion.chunk
        // (+ [DONE]) instead of a buffered JSON blob — pi's SSE decoder needs the
        // `data:` framing or it classifies the turn as a provider rejection.
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.write('data: ' + JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [
                { index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.json(completion);
    } catch (error) {
        console.error('❌ Error:', error);
        // 08-13 EVENING: headersSent guard — a crashed-stream attempt here
        // threw ERR_HTTP_HEADERS_SENT and killed the process the same way.
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.status(500).json({ error: { message: error.message, type: 'api_error' } });
        }
    }
});

// ── OpenAI Responses API (09-03: shannon/pi's "openai" provider speaks the
// Responses dialect; its preflight probe 404'd on /v1/responses. Translate
// Responses-dialect requests onto the same webchat flow as chat/completions
// so free-lane runs (shannon, pi agents) need no dialect change upstream.) ──
app.post('/v1/responses', async (req, res) => {
    try {
        const { model, input, instructions = '', stream, tools } = req.body || {};
        const routedModel = String(model || '').replace(/^claude\//, '');
        // Tool names offered by the caller (pi/shannon agents). Our lane model
        // responds in TEXT, so we bridge the Responses-API tool-call contract:
        // the model is told to end its reply with "CALL_TOOL: <name> <json>"
        // and we emit a real function_call item for it on output.
        const toolNames = Array.isArray(tools) ? tools.map((t) => (t && t.name) || '').filter(Boolean) : [];
        const CALL_RE = /CALL_TOOL:\s*([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})\s*$/m;
        const parseCall = (text) => {
            // Brace-balanced scan: find the LAST CALL_TOOL line, take the first
            // '{' after the name, walk to its matching '}' (any depth), then
            // tolerate trailing fences/backticks/whitespace.
            const idx = text.lastIndexOf('CALL_TOOL:');
            if (idx === -1) return null;
            const rest = text.slice(idx + 10).replace(/^[\s`]*/, '');
            const name = (rest.match(/^([A-Za-z0-9_.-]+)\s*/) || [])[1];
            if (!name || !toolNames.includes(name)) return null;
            const start = rest.indexOf('{', name.length);
            if (start === -1) return null;
            let depth = 0, got = false;
            const body = [];
            for (let i = start; i < rest.length; i++) {
                const ch = rest[i];
                if (ch === '{') { depth++; got = true; }
                else if (ch === '}') { depth--; if (depth === 0) { body.push(ch); break; } }
                if (got) body.push(ch);
            }
            return { name, args: body.join('') };
        };
        const messages = [];
        if (instructions) messages.push({ role: 'system', content: instructions });
        const toText = (x) => (typeof x === 'string' ? x : x && x.text ? x.text : '');
        const addInput = (item) => {
            if (typeof item === 'string') messages.push({ role: 'user', content: item });
            else if (Array.isArray(item)) messages.push({ role: 'user', content: item.map(toText).join('\n') });
            else if (item && item.type === 'message' && item.content)
                messages.push({
                    role: item.role === 'assistant' ? 'assistant' : 'user',
                    content: Array.isArray(item.content) ? item.content.map(toText).join('\n') : String(item.content),
                });
            else if (item && item.type === 'function_call_output' && item.output !== undefined)
                messages.push({ role: 'user', content: `[tool result]\n${String(item.output)}` });
        };
        if (Array.isArray(input)) input.forEach(addInput);
        else addInput(input);
        const rst = async (req_) => {
            const systemMessage = messages.find((m) => m.role === 'system');
            // 09-04 HISTORY FIX: pi (shannon) sessions are MULTI-TURN — turn 2+
            // carries only function_call_output + a short follow-up; the actual
            // task lives in the EARLIER messages. Using only the last user
            // message made the lane model reply "No concrete task was
            // provided". Rebuild the prompt from ALL non-system messages.
            const prompt = messages
                .filter((m) => m.role !== 'system')
                .map((m) => {
                    const body = typeof m.content === 'string'
                        ? m.content
                        : JSON.stringify(m.content ?? '');
                    return (m.role === 'assistant' ? 'ASSISTANT: ' : 'USER: ') + body;
                })
                .join('\n\n')
                .slice(-120000);
            if (!(await isConnected()) && !process.env.TEST_FAKE_RESPONSE) {
                try { await ensureConnected(); } catch (e) {
                    return { error: `Webchat not connected: ${e.message}` };
                }
            }
            let systemText = systemMessage?.content || '';
            // 09-03 TOOL BRIDGE: the pi agent loop needs model-side tool calls.
            // The formatText override REPLACES the gateway's relaxed chat format
            // (it is appended LAST, so any instruction in it wins over the
            // systemText protocol — that is exactly why a system-only protocol
            // was being ignored by the lane model before).
            let formatText = undefined;
            if (toolNames.length) {
                const allow = toolNames.slice(0, 24).join(', ');
                // 09-03 SCHEMA INJECTION: the lane model must construct valid
                // CALL_TOOL arguments; names alone are not enough (vuln agents
                // never emitted submit_exploitation_queue → output-validation
                // failed 15/15). Compact per-tool description + param schema.
                const schemaText = (config.toolSchemaSlice ? tools.slice(0, config.toolSchemaSlice) : tools).map((t) => {
                    const nm = t.name || '';
                    const desc = String(t.description || '').slice(0, 180);
                    let params = '';
                    const p = t.parameters || (t.input_schema) || {};
                    try { params = JSON.stringify(p).slice(0, 320); } catch { params = '{}'; }
                    return `- ${nm}${desc ? `: ${desc}` : ''} ${params ? `PARAMS ${params}` : ''}`;
                }).join('\n');
                systemText += (`\n\n### TOOL PROTOCOL\nAvailable tool calls: ${allow}.\n` + schemaText + '\n');
                formatText =
                    '### RESPONSE INSTRUCTIONS FOR THIS SESSION (OVERRIDE ALL OTHERS)\n' +
                    'You are a pentest ANALYST agent. A harness owns the tools and executes them for you.\n' +
                    'IF the assignment requires a tool call (e.g. submitting a queue), your reply MUST start\n' +
                    'with the CALL_TOOL line as the VERY FIRST line:\n' +
                    'CALL_TOOL: <name> <arguments-json-single-line-no-code-fence>\n' +
                    'and optional short analysis text may follow AFTER that line.\n' +
                    'NEVER answer a tool-requiring assignment without the CALL_TOOL line.\n' +
                    'Only when a task explicitly needs no tool, answer in plain text (NO CALL_TOOL line).\n' +
                    'Never emit code fences, markdown-ish wrappers, or the gateway json-tool block.';
            }
            const text = await enqueue(() =>
                handleRequest(systemText, prompt, buildExecutableToolDefs(), undefined, undefined,
                    { formatText })
            );
            // Paranoia guard: the lane strips leading whitespace; normalize \r.
            return { text: String(text || '') };
        };
        const outputFor = (text) => {
            const pc = parseCall(text);
            if (pc) {
                let args = pc.args;
                try { JSON.parse(pc.args); }
                catch { args = '{}'; }
                console.log('[responses] function_call emitted:', pc.name, '(' + args.length + ' chars)');
                return [{ type: 'function_call', id: 'fc_' + Math.random().toString(36).slice(2, 12),
                    call_id: 'call_' + Math.random().toString(36).slice(2, 12),
                    name: pc.name, arguments: args }];
            }
            // 09-03 JSON-TEXT FALLBACK: shannon's pi prompt forbids "output JSON
            // as text", yet the lane model tends to deliver the queue inline —
            // which pi then sees as prose (no submit → queue file missing →
            // output validation fails). If a submit*_queue tool is offered and
            // the tail of the reply looks like the structured queue object,
            // upgrade it into a REAL function_call so the worker writes the file.
            const submitTool = toolNames.find((n) => /queue/i.test(n));
            if (text) {
                console.log('[responses] msg-reply (no call): ' + String(text).replace(/\s+/g, ' ').slice(0, 240));
                console.log('[responses] tail-text: ' + String(text).replace(/\s+/g, ' ').slice(-400));
            }
            if (submitTool && text) {
                const tail = text.slice(-4000);
                const m = tail.match(/\{[\s\S]*\}/);
                if (m) {
                    try {
                        const obj = JSON.parse(m[0]);
                        const keys = Object.keys(obj);
                        const looksQueue = keys.some((k) => /find|exploit|vuln|queue|target|evidence|severity|confidence|description|vulnerability|id/i.test(k));
                        if (looksQueue) {
                            console.log('[responses] json-text queue fallback ->', submitTool);
                            return [{ type: 'function_call', id: 'fc_' + Math.random().toString(36).slice(2, 12),
                                call_id: 'call_' + Math.random().toString(36).slice(2, 12),
                                name: submitTool, arguments: JSON.stringify(obj) }];
                        }
                    } catch { /* not JSON */ }
                }
            }
            return [{ type: 'message', role: 'assistant', stop_reason: 'end_turn',
                content: [{ type: 'output_text', text: (text || '').trim() }] }];
        };
        const wrap = (text) => ({
            id: 'resp_' + Math.random().toString(36).slice(2, 12),
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model: routedModel || model,
            output: outputFor(text),
            usage: { input_tokens: 0, output_tokens: (text || '').length, total_tokens: (text || '').length },
        });
        const result = await rst(req);
        if (result.error) return res.status(503).json({ error: { type: 'api_error', message: result.error } });
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: wrap(result.text) }) + '\n\n');
            const items = outputFor(result.text);
            items.forEach((item, idx) => {
                res.write('event: response.output_item.added\ndata: ' + JSON.stringify({
                    type: 'response.output_item.added', output_index: idx, item,
                }) + '\n\n');
                if (item.type === 'function_call') {
                    // pi's decoder only finalizes a functionCall slot that has seen
                    // function_call_arguments.delta (it requires partialJson present);
                    // missing these = tool call silently dropped → agent dies w/o submit.
                    res.write('event: response.function_call_arguments.delta\ndata: ' + JSON.stringify({
                        type: 'response.function_call_arguments.delta', output_index: idx, delta: item.arguments || '{}',
                    }) + '\n\n');
                    res.write('event: response.function_call_arguments.done\ndata: ' + JSON.stringify({
                        type: 'response.function_call_arguments.done', output_index: idx, arguments: item.arguments || '{}',
                    }) + '\n\n');
                }
                res.write('event: response.output_item.done\ndata: ' + JSON.stringify({
                    type: 'response.output_item.done', output_index: idx, item,
                }) + '\n\n');
            });
            res.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: wrap(result.text) }) + '\n\n');
            return res.end();
        }
        res.json(wrap(result.text));
    } catch (error) {
        console.error('❌ /v1/responses error:', error);
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.status(500).json({ error: { type: 'api_error', message: error.message } });
        }
    }
});

// ── Anthropic-compatible messages (so Claude Code can point at it) ──
// stream=true gets the full Anthropic SSE event sequence — Claude Code
// REQUIRES streaming, so this is the path that matters.
app.post('/v1/messages', async (req, res) => {
    // 08-16 HEARTBEAT-GUARD FIX: the keepalive interval only exists on the
    // streaming branch, but the catch block cleared it unconditionally — a
    // NON-stream request (curl, some clients) that threw in handleRequest
    // landed in the catch with heartbeat in the const TDZ → ReferenceError →
    // the whole gateway process crashed ("connection refused" for everyone).
    let heartbeat = null;
    try {
        const { system, messages, tools, model, stream } = req.body || {};
        // 08-14 GATEWAY PICKER: strip the claude/ prefix from discovery-row
        // ids ('claude/qwen webchat' → 'qwen webchat' → route target).
        const routedModel = String(model || '').replace(/^claude\//, '');
        const routedBody = routedModel !== model ? { ...req.body, model: routedModel } : req.body;
        if (WEBCHAT_ROUTES[routedModel]) {
            await ensureRouteUp(WEBCHAT_ROUTES[routedModel]);
            // OmniRoute validates model names on /api/v1/messages: the
            // deepseek-v4-* names it advertises have no active credentials,
            // only the auto/best-* combo family actually routes. Rewrite the
            // picker alias to auto/best-coding — OmniRoute's own free
            // upstreams only. Never the paid key on this route.
            // 08-14: the gemini gateway's OWN model name is
            // 'gemini 3.7 flash webchat' (not the 'gemini webchat' route
            // key) — a verbatim passthrough makes it fall through to ITS
            // paid proxy and 400. Rewrite the alias like omniroute.
            const targetBody =
                routedModel === 'omniroute'
                    ? { ...routedBody, model: 'auto/best-coding' }
                    : routedModel.startsWith('gemini')
                        ? { ...routedBody, model: 'gemini 3.7 flash webchat' }
                        : routedBody;
            // 08-15 DRIFT-JUDGE FIX: OmniRoute 3.8.x serves its API under
            // /api/v1/* — the old '/v1/messages' path returned the Next.js
            // app shell (HTML) and the drift judge call hung on it.
            return proxyTo(
                req, res, WEBCHAT_ROUTES[routedModel],
                routedModel === 'omniroute' ? '/api/v1/messages' : '/v1/messages',
                targetBody
            );
        }
        if (!isWebchatModel(routedBody)) {
            // 08-19 COST SLASH: same as the openai route — fail fast locally,
            // never proxy to the paid DeepSeek API unless explicitly allowed.
            if (process.env.ALLOW_PAID_UPSTREAM === '1') {
                return proxyTo(req, res, UPSTREAM_ANTHROPIC.base, '/v1/messages', routedBody);
            }
            console.log(`⛔ paid-upstream rejected (anthropic route): model=${String(routedBody?.model).slice(0, 80)}`);
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_model',
                    message: `paid upstream disabled — model "${String(routedBody?.model).slice(0, 80)}" is not the webchat model`,
                },
            });
        }

        if (!(await isConnected()) && !process.env.TEST_FAKE_RESPONSE) {
            try {
                await ensureConnected(); // lazy connect: attach on first request
            } catch (e) {
                console.log('⚠️ 503: connect failed:', e.message);
                return res.status(503).json({
                    type: 'error',
                    error: { type: 'api_error', message: `Webchat not connected: ${e.message} — run with HEADLESS=false, log in, then POST /connect` },
                });
            }
        }

        const systemText =
            typeof system === 'string'
                ? system
                : Array.isArray(system)
                  ? system.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
                  : '';

        const userMessage = [...(messages || [])].reverse().find((m) => m.role === 'user');
        const prompt = Array.isArray(userMessage?.content)
            ? userMessage.content
                  .map((b) => (b.type === 'text' ? b.text : `[${b.type} content]`))
                  .join('\n')
            : userMessage?.content || '';

        // 08-19 GREETING SHORT-CIRCUIT (user: "i said hello and its doing allat"):
        // in user/conversation mode a pure greeting must NEVER trigger tool
        // work — the model reached for list_dir on a plain "hello". Inject NO
        // tool defs → it can only reply conversationally; no tool calls, no
        // malformed-call corrections, no workspace probing.
        const isPureGreeting =
            config.allowPlainText &&
            /^\s*(?:hi+|hello|hey+|yo+|sup|howdy|good\s*(?:morning|afternoon|evening)|whats? up|how(?:'s| is| are)\s+(?:it going|you))[\s!.,?~]*$/i.test(prompt);
        const toolDefs = isPureGreeting ? [] : buildExecutableToolDefs();

        const modelName = model || config.modelName;

        if (!stream) {
            const text = await enqueue(() => handleRequest(systemText, prompt, toolDefs, undefined, undefined,
                { autonomous: req.body?.autonomous === true || req.headers['x-autonomous'] === '1' }));
            return res.json({
                id: 'msg_' + Math.random().toString(36).slice(2, 12),
                type: 'message',
                role: 'assistant',
                model: modelName,
                content: [{ type: 'text', text }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 0, output_tokens: text.length },
            });
        }

        // ── SSE: the full Anthropic streaming sequence ──
        // The tool loop can run for minutes with the client seeing NOTHING —
        // the user read that as "it never sent anything". So block 0 streams
        // LIVE progress lines as each tool executes (and each rejection fires);
        // the final answer is block 1, emitted when the loop completes.
        const msgId = 'msg_' + Math.random().toString(36).slice(2, 12);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Never write after the client left (mid-handoff swaps run long) —
        // res.write on an ended response fires an unhandled stream error.
        const ev = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

        // 08-14 KEEPALIVE: the webchat cogitates SILENTLY for minutes before
        // its first chunk (the tab streams no thinking tokens), and the
        // gateway forwards nothing during that wait — Claude Code's
        // stream-idle watchdog then kills the turn ("Stream idle timeout -
        // no chunks received"; observed 08-13 22:5x, 11-min churn on the
        // 'add EVERYTHING' helpotron run while TWO clients starved on one
        // tab). SSE comment lines are ignored by every SSE parser — they
        // feed the watchdog without polluting the event stream. Started
        // BEFORE enqueue() so queued clients (single-lane tab) are fed too.
        heartbeat = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
        }, 15000);

        ev('message_start', {
            type: 'message_start',
            message: {
                id: msgId,
                type: 'message',
                role: 'assistant',
                model: modelName,
                content: [],
                stop_reason: null,
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        });

        let blockIndex = 0;
        // 08-15 NARRATION FIX (owner-urgent): emit REAL Anthropic content
        // blocks instead of one flat '💬 JSON' text blob. A narration text
        // event becomes a text block; a work tool becomes a tool_use block.
        // The client then renders a normal text message BEFORE the tool call.
        const onProgress = (evt) => {
            if (evt.type === 'text') {
                const t = String(evt.text ?? '');
                if (!t) return;
                ev('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
                ev('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: t } });
                ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                blockIndex++;
                return;
            }
            if (evt.type === 'tool') {
                // 08-16 TOOL-VISIBILITY FIX: the gateway executes webchat tools
                // internally, so streaming them as tool_use made the CLIENT
                // (Claude Code) try to execute gateway-internal tools it does
                // not have — "No such tool available: send_message" — and the
                // turn broke. Emit a short text progress line instead; the
                // 💬 narration already explains what the tool is doing.
                const t = '🔧 ' + evt.name + ' ' + argsSummary(evt.name, evt.args ?? {});
                ev('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
                ev('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: t } });
                ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                blockIndex++;
                return;
            }
            // rejected / status events: surface as a short text block, never a bare tool JSON row
            const t = String(evt.text ?? (evt.type === 'rejected' ? 'rejected' : ''));
            if (!t) return;
            ev('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
            ev('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: t } });
            ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            blockIndex++;
        };

        // Client gone (interrupt, timeout) → abort the webchat loop so it stops
        // feeding the tab; the in-flight generation is abandoned with it.
        let aborted = false;
        res.on('close', () => { aborted = true; });

        const text = await enqueue(() => handleRequest(systemText, prompt, toolDefs, onProgress, () => aborted,
            { autonomous: req.body?.autonomous === true || req.headers['x-autonomous'] === '1' }));
        if (text === null) { if (heartbeat) clearInterval(heartbeat); return; } // aborted — nothing more to write


        ev('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
        });

        // chunk the text so clients see progress
        for (let i = 0; i < text.length; i += 512) {
            ev('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: text.slice(i, i + 512) },
            });
            await sleep(20);
        }

        ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        ev('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: text.length },
        });
        ev('message_stop', { type: 'message_stop' });
        if (heartbeat) clearInterval(heartbeat);
        res.end();
    } catch (error) {
        if (heartbeat) clearInterval(heartbeat);
        console.error('❌ Error:', error);
        // 08-13 EVENING: the 08-12 writableEnded guard missed the SSE path —
        // ev() writes had ALREADY sent headers when handleRequest threw (180s
        // waitForResponse timeout mid run-until-done task) → res.json() threw
        // ERR_HTTP_HEADERS_SENT → whole process crashed → "connection refused"
        // for every client. Guard headersSent too; on the stream, end with an
        // SSE error event instead of a 500.
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.status(500).json({ type: 'error', error: { type: 'api_error', message: error.message } });
        } else if (!res.writableEnded && !res.destroyed) {
            try {
                res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message } })}\n\n`);
                res.end();
            } catch (e) { /* client already gone */ }
        }
    }
});

// ── Manual connect / reconnect ──
app.post('/connect', async (req, res) => {
    try {
        await ensureConnected();
        res.json({ message: 'Connected to webchat', url: config.webchatUrl, page: getPage()?.url() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ──────────────────────────────────────────────────────
// STARTUP
// ──────────────────────────────────────────────────────
async function main() {
    console.log('🚀 Starting Webchat API...');
    console.log(`🔌 Config: host=${config.host}:${config.port}, headless=${config.headless}, timeout=${config.timeout}ms`);
    if (config.apiToken) console.log('🔑 Auth: bearer token required');
    if (config.skipBrowser) console.log('⏭️  SKIP_BROWSER=true — no browser until POST /connect');

    // Lazy connect: the browser opens on the first request (or POST /connect),
    // so the server starts even when the webchat is unreachable.
    app.listen(config.port, config.host, () => {
        console.log(`✅ Server running on http://${config.host}:${config.port}`);
        console.log(`📡 Webchat: ${config.webchatUrl}`);
        console.log(`🔧 Tools available: ${getToolDefinitions().length}`);
        console.log('🌐 Browser connects on first request. If HEADLESS=false, log in to the window when it opens.');
    });
}

// ──────────────────────────────────────────────────────
// CLEANUP
// ──────────────────────────────────────────────────────
async function gracefulShutdown(reason, code) {
    console.log(`\n🔴 ${reason} — shutting down...`);
    // Bounded: closeBrowser() can hang on a STALE CDP connection (Chrome
    // died — puppeteer waits up to protocolTimeout). Never wedge shutdown.
    await Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 5000))]);
    process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => gracefulShutdown(sig, 0));
}
// 08-20 (audit BUG-12): an uncaught exception previously exited WITHOUT
// closing the browser — the detached Chrome kept running (zombie, RAM leak
// until the OOM-killer). Same bounded close, then exit 1 so supervisors see
// a real crash.
process.on('uncaughtException', (err) => {
    console.error('💥 uncaughtException:', err);
    gracefulShutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
    console.error('💥 unhandledRejection:', err);
    gracefulShutdown('unhandledRejection', 1);
});

main();
