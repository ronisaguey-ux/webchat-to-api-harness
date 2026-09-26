const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const config = require('./src/core/config');

// 08-16 (user): the gemini webchat lane renders tool receipts in the visible
// tab, and the deepseek lane (plan executor) runs on the SAME formatToolResult
// function. Gemini wants NO file content in the tab — only tool name + line
// numbers — while the deepseek executor still needs the content in its feed.
// Gate the clean mode to gemini only.
const IS_GEMINI = (config.modelName || '').toLowerCase().startsWith('gemini');
const browser = require('./src/browser/browser');
const {
    initBrowser, connectToWebchat, sendPrompt, closeBrowser, getPage, probePage,
    buildFullPrompt, openNewChat, openNewChatAndSeed, getReqBodyChars, getAndClearThinkBuf,
    resetTeeForHandoff, takeThreadSwap, browserAlive, markShuttingDown,
} = browser;
const { getToolDefinitions, getExecutableToolDefinitions, executeTool, parseToolCall, parseToolCalls, cleanProse } = require('./src/tools/tools');
const { McpPool } = require('./src/tools/mcp');
const compactor = require('./src/runtime/compactor');
const memory = require('./src/runtime/memory');

// 09-22 (owner): attach ANY MCP server. The pool owns discovery and routing; it is
// created from config here and discovered lazily at the first request (fail-open).
const mcpPool = new McpPool(config.mcpServers);

// ── Main-reply injection (08-14, user) ───────────────────────────────────
// The webchat can message MAIN via the send_message_to_main tool. MAIN
// replies into claude_webchat_outbox.json with "to": <this gateway's thread
// URL>; on the NEXT request to this thread the pending replies are appended
// to the prompt so the webchat sees them in context. Seen-markers persist
// per-port so replies are not re-injected after a gateway restart. The
// telegram responder skips "to"-tagged items (they are gateway-routed).
const PATHS = require('./src/core/paths');
const ANTI_SPIRAL = require('./src/runtime/anti_spiral');
const RATE_LIMIT = require('./src/runtime/rate_limit');
const WEBCHAT_MODELS = require('./src/models/webchat-models');
const MAIN_REPLY_FILE = PATHS.mainReplyFile();
const MAIN_REPLY_SEEN_FILE = PATHS.mainReplySeenFile(process.env.PORT);
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
      // `forModel` distinguishes the two consumers of this function, and the
      // distinction is load-bearing:
      //   - the STREAMED receipt (forModel false) is what a human watches; it should
      //     be a readable summary, not a wall of file content;
      //   - the TAB FOLLOW-UP (forModel true) is what the MODEL reads, and without
      //     the real content it is blind — it re-reads the same file forever and then
      //     fabricates an answer.
      // Measured: asked to read a file containing `CANARY-7731`, the lane replied
      // `CANARY: opencode-canary-2026-09-23` — a confident invention — because the
      // content was stripped before it ever reached the model. The comment on the
      // caller already claimed the receipt "carries the full content for
      // read_file/run_bash"; the code did the opposite, so the two disagreed and the
      // model lost.
      const forModel = opts.forModel === true;
      const name = call.toolName;
      const args = call.args ?? {};
      const limit = cap || 6000;
    try {
        if (name === 'run_bash') {
            const ok = !!result.success;
            const status = ok ? '✅ bash command finished' : '❌ bash command failed';
            const detail = result.error ? ` (${result.error})` : '';
            // 08-16 (user): the gemini TAB shows no command output — just the
            // command, the status and how big the output was. That is the HUMAN view.
            // The model still receives the output below: a lane that cannot read a
            // command's result cannot verify anything, and it invents instead.
            if (IS_GEMINI && !forModel) {
                const stdout = String(result.stdout ?? '');
                const stderr = String(result.stderr ?? '');
                const outChars = stdout.length + stderr.length;
                const outLines = (stdout + '\n' + stderr).split('\n').length;
                return `🖥️ run_bash → $ ${truncateStr(String(args.command ?? ''), 300)}\n\n${status}${detail} — output ${outChars} chars / ${outLines} lines (content hidden from the tab; the model receives it)`;
            }
            let out = `🖥️ run_bash → $ ${truncateStr(String(args.command ?? ''), 400)}\n\n${status}${detail}\n`;
            const stdout = String(result.stdout ?? '').trim();
            const stderr = String(result.stderr ?? '').trim();
            if (stdout) out += `\n\`\`\`\n${truncateStr(stdout, limit)}\n\`\`\`\n`;
            if (stderr) out += `\n\`\`\`\nstderr:\n${truncateStr(stderr, Math.min(limit, 6000))}\n\`\`\`\n`;
            return out;
        }
        if (name === 'read_file') {
            const content = String(result.content ?? '');
            const lineCount = content ? content.split('\n').length : 0;
            const total = result.totalLength ?? content.length;
            const header = `📄 read_file → ${args.path ?? '?'}${lineCount ? ` (lines 1-${lineCount})` : ' (empty)'}`;
            const truncNote = (result.truncated || total > content.length)
                ? ` — truncated at ${content.length} chars (${total} total)` : '';
            // The tab receipt is a summary; the MODEL gets the content.
            //
            // Dropping the content here made the lane structurally blind: it re-read
            // the same file until the round budget ran out, then fabricated an answer.
            // Measured — asked to read a file containing `CANARY-7731`, it replied
            // `CANARY: opencode-canary-2026-09-23`. A consumer that cannot see what it
            // read will always guess, and a guess is indistinguishable from a result.
            if (!forModel) return header + truncNote;
            if (!content) {
                return header + truncNote + (result.error ? ` — ❌ ${result.error}` : ' (empty)');
            }
            return header + truncNote + '\n\n```\n' + truncateStr(content, limit) + '\n```';
        }
        if (name === 'write_file') {
            const path = args.path ?? '?';
            const diff = diffLines(result.oldContent, args.content);
            // 08-16 (user): gemini tab shows line counts + ranges, NO diff.
            if (IS_GEMINI) {
                const bits = [];
                if (diff.added) {
                    const r = lineRangeFromDiff(diff.text, '+');
                    bits.push(`adding ${diff.added} line${diff.added === 1 ? '' : 's'}${r ? ` (${r})` : ''}`);
                }
                if (diff.removed) {
                    const r = lineRangeFromDiff(diff.text, '-');
                    bits.push(`deleting ${diff.removed} line${diff.removed === 1 ? '' : 's'}${r ? ` (${r})` : ''}`);
                }
                if (!bits.length) return `✏️ write_file → ${path} (no content change)`;
                return `✏️ write_file → ${path} — ${bits.join(', ')} (content hidden)`;
            }
            if (!diff.text) return `✏️ write_file → ${path} (no content change)`;
            const bits = [];
            if (diff.added) bits.push(`adding ${diff.added} line${diff.added === 1 ? '' : 's'} to this file`);
            if (diff.removed) bits.push(`deleting ${diff.removed} line${diff.removed === 1 ? '' : 's'}`);
            return `✏️ write_file → ${path} — ${bits.join(', ')}\n\n\`\`\`diff\n${diff.text}\n\`\`\``;
        }
        if (!result || result.success === false) {
            return `🔧 ${name} ${argsSummary(name, args)}\n\n❌ ${(result && result.error) || 'tool failed'}`;
        }
        const j = JSON.stringify(result ?? {});
        const capped = j.length > limit ? j.slice(0, limit) + '… [truncated]' : j;
        return `🔧 ${name} ${argsSummary(name, args)}\n\n\`\`\`json\n${capped}\n\`\`\``;
    } catch (e) {
        return `🔧 ${name} — (result formatting error: ${e.message})`;
    }
}

// 08-13 RATE-LIMIT GATE (user-visible hang fix): DeepSeek's account limiter
// rejects bursts with "Messages too frequent. Try again later." — parallel
// consumers (user client + orchestrator) hammering the same account made
// requests hang at "Waiting for response...". Sends are spaced by this many
// ms (queued, not rejected) so the account never sees a burst from us.
// 09-12 (owner): a FIXED gap is itself a bot signature. Pick a fresh random
// delay in [MIN, MAX] for EVERY send, on EVERY lane, so the cadence never
// repeats. MIN_SEND_INTERVAL_MS stays as the floor for backwards compatibility;
// SEND_GAP_MIN_MS / SEND_GAP_MAX_MS set the range (default 20s-80s).
const MIN_SEND_INTERVAL_MS = parseInt(process.env.MIN_SEND_INTERVAL_MS || '6000', 10);
const SEND_GAP_MIN_MS = parseInt(process.env.SEND_GAP_MIN_MS || '20000', 10);
const SEND_GAP_MAX_MS = parseInt(process.env.SEND_GAP_MAX_MS || '80000', 10);
function nextSendGapMs() {
    const lo = Math.max(0, Math.min(SEND_GAP_MIN_MS, SEND_GAP_MAX_MS));
    const hi = Math.max(lo, SEND_GAP_MAX_MS);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}
let lastSendAt = 0;
// Process lifetime anchor for the /health wedge check. lastSendAt starts at 0, so
// without this an idle gateway computes Date.now() - 0 and reports wedged:true.
const processStartAt = Date.now();

// 08-14 GLOBAL SEND MUTEX (owner rule: deepseek webchat supports ONE message
// in-flight per account — "u cant have 2 deepseek webchats working at once",
// but "if u make sure a message is never sent to more then one chat at once
// u can basically have infinite chats open"). ALL deepseek-tab gateways
// (8080/8081/8082/8094, any browser) serialize on a shared lock held across
// the full send→response window, so tabs never generate concurrently.
// mkdir is atomic (one winner), a heartbeat keeps the mtime fresh so long
// generations aren't stolen, and a 120s-stale steal frees the lock if a
// gateway dies mid-hold. Non-deepseek gates (qwen/kimi/gemini) skip it.
// 09-12 (owner): the mutex is per WEBCHAT ACCOUNT, not global. Making gemini
// single-threaded via needsSingleThread() above accidentally put it behind the
// SAME filesystem lock as the three deepseek gateways — so a wedged deepseek
// send held the lock and gemini queued forever ('deepseek mutex: queued' in the
// gemini log, then RemoteDisconnected to the engine).
// 09-12 (owner): the three deepseek webchats are THREE DIFFERENT ACCOUNTS — they
// are meant to run CONCURRENTLY. Deriving the lock from the webchat HOST put all
// three behind one lock and serialized accounts that have nothing to do with each
// other, so three lanes behaved like one. Derive it from the ACCOUNT instead:
// WEBCHAT_ACCOUNT if set, else the basename of WEBCHAT_PROFILE (each gateway has
// its own profile dir), else the host as a last resort. One lock per account =
// one message in flight per account, which is the real rule.
const WEBCHAT_HOST = (() => {
    try { return new URL(String(config.webchatUrl || '')).host.replace(/[^a-z0-9.]/gi, '_'); }
    catch { return 'default'; }
})();
const WEBCHAT_ACCOUNT = (() => {
    const slug = (v) => String(v).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (process.env.WEBCHAT_ACCOUNT) return slug(process.env.WEBCHAT_ACCOUNT);
    if (process.env.WEBCHAT_PROFILE) return slug(path.basename(process.env.WEBCHAT_PROFILE));
    return WEBCHAT_HOST;
})();
// os.tmpdir() rather than a hardcoded /tmp: on Windows "/tmp" resolves to
// C:\tmp, which usually does not exist, so mkdirSync threw ENOENT on the very
// first send and the old catch treated it as "another gateway holds the lock" -
// every request then waited out the full lock timeout and looked like a hang.
const DEEPSEEK_LOCK_DIR = process.env.WEBCHAT_LOCK_DIR
    || path.join(os.tmpdir(), `webchat_mutex_${WEBCHAT_ACCOUNT}`);
const LOCK_STEAL_MS = 90000; // 3 heartbeats (30s each): a holder whose mtime stopped moving is dead
const LOCK_HEARTBEAT_MS = 30000;
// 09-12: a request queued behind another send on the SAME account must fail fast.
// At 30 min a queued request sat silently while the engine's lane budget (400s)
// expired, so the engine logged "timeout after 400s — lanes unavailable" even
// though the account was healthy and serving the first request. 120s is longer
// than one real send, short enough that the engine still gets an answer (an
// error) and can hop to another lane.
const LOCK_ACQUIRE_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_LOCK_TIMEOUT_MS || '120000', 10);
let lockHeartbeat = null;
let lockDepth = 0;

function usesDeepSeek() {
    return /chat\.deepseek\.com/.test(String(config.webchatUrl || ''));
}

// 09-12 (owner): gemini is a webchat too and must be SINGLE-THREADED — no
// concurrency over the tab. The engine runs EXEC_WORKERS>1, so two step workers
// could hit the same tab at once; the log showed overlapping "Sending prompt"
// lines and the tab then cogitated for minutes. Serialize every webchat tab, not
// just deepseek.
function needsSingleThread() {
    const url = String(config.webchatUrl || '');
    return /chat\.deepseek\.com|gemini\.google\.com/.test(url);
}

async function acquireDeepSeekLock() {
    if (!needsSingleThread()) return;
    // Reentrant: context-handoff / retry flows send nested messages from
    // within an already-locked request (same process) — depth-count them.
    if (lockDepth > 0) { lockDepth++; return; }
    // Create the lock PARENT before the retry loop. mkdirSync(lockDir) without
    // {recursive:true} fails with ENOENT when the parent is missing, and the
    // old blanket catch read that as "held by another gateway" — so the loop
    // spun for the whole LOCK_ACQUIRE_TIMEOUT_MS and the caller saw a hang.
    // A missing/unwritable parent is a configuration fault and must be loud.
    const lockParent = path.dirname(DEEPSEEK_LOCK_DIR);
    try {
        fs.mkdirSync(lockParent, { recursive: true });
    } catch (e) {
        throw new Error(
            `webchat mutex: cannot create lock parent ${lockParent} `
            + `(${e.code || 'UNKNOWN'}: ${e.message})`
        );
    }
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    let waited = false;
    while (true) {
        try {
            fs.mkdirSync(DEEPSEEK_LOCK_DIR);
            break; // acquired
        } catch (e) {
            // ONLY EEXIST means another gateway genuinely holds it. Every other
            // errno (ENOENT, EACCES, EPERM, ENOSPC, EROFS, ENOTDIR) is a real
            // filesystem fault and must surface instead of being waited out.
            if (e.code !== 'EEXIST') {
                throw new Error(
                    `webchat mutex: cannot create lock ${DEEPSEEK_LOCK_DIR} `
                    + `(${e.code || 'UNKNOWN'}: ${e.message})`
                );
            }
        }
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
        } catch (e) {
            // ENOENT = stolen between stat+rmdir by a sibling gateway; retry.
            // Anything else is a real fault - surface it rather than spin.
            if (e.code && e.code !== 'ENOENT') {
                throw new Error(
                    `webchat mutex: cannot inspect lock ${DEEPSEEK_LOCK_DIR} `
                    + `(${e.code}: ${e.message})`
                );
            }
        }
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
// 09-14 (owner): webchat tabs accumulate an unbounded thread and the renderer
// eventually crashes (measured: chatgpt at 144 rows / 429KB DOM -> Target closed).
// Open a fresh chat every N sends so the thread never grows that far.
//
// 09-21 BUGFIX (reported): the reset used to fire from countedSend(), which is
// called for EVERY internal send — including tool-loop corrections, tool-result
// follow-ups and repair nudges. A multi-tool Claude Code request could therefore
// hit N sends MID-RESPONSE, call openNewChat(), navigate the tab away from the
// live conversation and break the tool loop (surface as "Server error
// mid-response"). The reset is now ONLY performed at a request boundary, before
// a new client request starts, never during one. Set NEW_CHAT_EVERY_SENDS=0 to
// disable automatic resets entirely (manual POST /newchat still works).
const NEW_CHAT_EVERY_SENDS = parseInt(process.env.NEW_CHAT_EVERY_SENDS || '5', 10);
let sendCount = 0;

// ── Send latency ─────────────────────────────────────────────────────────────
// How long the webchat takes to answer, over a rolling window. The dashboard needs
// this because "how slow is the lane right now" is the first question when a run
// looks stuck, and a single last-send figure cannot tell a one-off stall from a lane
// that has genuinely got slower.
//
// Timed around sendPrompt only — NOT around the pacing gate above it. The gate's
// wait is deliberate spacing, not latency; folding it in would report a number that
// changes with the send interval rather than with the model.
const LATENCY_WINDOW = 40;
let sendLatencies = [];
let lastLatencyMs = null;

function recordLatency(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    lastLatencyMs = ms;
    sendLatencies.push(ms);
    if (sendLatencies.length > LATENCY_WINDOW) sendLatencies.shift();
}

function latencyStats() {
    const n = sendLatencies.length;
    if (!n) return { samples: 0, lastMs: null, avgMs: null, p50Ms: null, minMs: null, maxMs: null };
    const sorted = [...sendLatencies].sort((a, b) => a - b);
    const sum = sendLatencies.reduce((a, b) => a + b, 0);
    return {
        samples: n,
        lastMs: lastLatencyMs,
        avgMs: Math.round(sum / n),
        p50Ms: sorted[Math.floor(n / 2)],
        minMs: sorted[0],
        maxMs: sorted[n - 1],
    };
}
// True while handleRequest() is running. The reset is refused whenever this is
// set, so a tool-loop send can never navigate the tab out from under itself.
let requestInFlight = false;
// Post-swap grace: the first request after a handoff always reaches the
// fresh thread (its seeded body can be ≥ threshold by itself — overhead +
// doc — and must not re-trigger the pre-send handoff immediately).
let lastHandoffAt = 0;
// Per-request handoff context (module-level so countedSend can trigger the
// handoff from the ERROR path — see the CONTEXT_FULL catch below). Refreshed
// at every handleRequest start and whenever a tool executes.
let activeHandoffCtx = null;
// Called ONCE per client request, before the conversation starts. Never from
// inside the tool loop. Returns true when it swapped the thread.
async function maybeResetThreadAtBoundary(reason) {
    if (!(NEW_CHAT_EVERY_SENDS > 0)) return false;   // 0 = disabled
    if (requestInFlight) return false;               // never mid-response
    if (sendCount < NEW_CHAT_EVERY_SENDS) return false;
    sendCount = 0;
    console.log(`🆕 opening a fresh chat (every ${NEW_CHAT_EVERY_SENDS} sends, at a request boundary${reason ? ` — ${reason}` : ''})`);
    try {
        await openNewChat();
        return true;
    } catch (e) {
        console.warn('⚠️ fresh-chat open failed:', e.message);
        return false;
    }
}
// ── Jev interceptor (2026-09-22, Bob's request) ─────────────────────────────
// Sits at the sendPrompt funnel so EVERY reply the harness receives passes it.
// JEV_INTERCEPT: 'off' (default) | 'shadow' (log the verdict, change nothing) |
// 'enforce' (treat an unusable reply as a failed send so the caller retries).
// Shadow is the default on purpose: this must be measured before it is allowed
// to change behaviour. The Jev client itself fails OPEN, so a Jev outage can
// never break a send.
const JEV_INTERCEPT = String(process.env.JEV_INTERCEPT || 'off').toLowerCase();
let jevStats = { checked: 0, unusable: 0, failed: 0 };
let _jev = null;
function jev() {
    // jev.js moved to src/runtime/ in the layout refactor; this path was never updated, and
    // the bare `catch` swallowed the module-not-found and printed a warning nobody reads —
    // so the router was silently DISABLED in every deployment (measured 2026-09-24). A
    // failed optional require must not read as "feature off"; the warn now says where it
    // looked.
    if (_jev === null) {
        try {
            _jev = require('./src/runtime/jev.js');
        } catch (e) {
            _jev = false;
            console.warn('⚠️ jev.js unavailable at ./src/runtime/jev.js:', e.message);
        }
    }
    return _jev || null;
}
// The contract a PASSTHROUGH_FORMAT caller ships is the edits JSON; the prompt
// itself carries it, so the reply is judged against the tail of the message.
function jevContractFrom(msg) {
    const m = String(msg || '');
    const i = m.lastIndexOf('{"edits"');
    return i >= 0 ? m.slice(i, i + 800) : 'a usable answer the caller can act on';
}
async function jevCheckReply(msg, reply) {
    if (JEV_INTERCEPT === 'off' || !reply) return;
    const j = jev();
    if (!j) return;
    const verdict = await j.replyIsUsable(reply, jevContractFrom(msg));
    if (!verdict.ok) { jevStats.failed++; return; }   // Jev down/timeout -> fail open
    jevStats.checked++;
    if (!verdict.usable) {
        jevStats.unusable++;
        console.log(`🧭 [jev:${JEV_INTERCEPT}] reply judged UNUSABLE (${verdict.reason}) — checked=${jevStats.checked} unusable=${jevStats.unusable} of ${jevStats.checked}`);
        if (JEV_INTERCEPT === 'enforce') {
            const e = new Error(`Webchat reply judged unusable by Jev (${verdict.reason})`);
            e.retryable = true;      // let the existing retry gate act on it
            throw e;
        }
    } else if (process.env.JEV_VERBOSE === 'true') {
        console.log(`🧭 [jev:${JEV_INTERCEPT}] reply usable (${verdict.reason})`);
    }
}

async function countedSend(msg, defs) {
    // Counted here, ACTED ON only at a request boundary (see
    // maybeResetThreadAtBoundary) — a tool-loop send must never navigate the tab.
    sendCount += 1;
    // 08-14 GLOBAL SEND MUTEX: wait for any other deepseek-tab gateway to
    // finish its generation before sending (owner rule: one in-flight
    // message per account). Held through the response; released in finally.
    await acquireDeepSeekLock();
    try {
    // 08-13 RATE-LIMIT GATE: queue-spaced sends (see MIN_SEND_INTERVAL_MS
    // above). DeepSeek rejected burst traffic with a hint-error that this
    // harness previously could not see — requests hung until timeout, the
    // client retried, and the retry storm deepened the limit.
    // 09-12 (owner): 30s minimum between EVERY deepseek send, ACROSS all lanes.
    // `lastSendAt` is per-process, so three lane gateways each spaced themselves
    // and still hit the account together. Use a shared timestamp file so every
    // deepseek gateway honours the same gap.
    const SHARED_SEND_FILE = process.env.SEND_SPACING_FILE
        || path.join(os.tmpdir(), `webchat_last_send_${WEBCHAT_ACCOUNT}`);
    const sharedWaitMs = (() => {
        if (!needsSingleThread()) return 0;
        try {
            const prev = parseInt(fs.readFileSync(SHARED_SEND_FILE, 'utf-8'), 10) || 0;
            return Math.max(0, prev + MIN_SEND_INTERVAL_MS - Date.now());
        } catch { return 0; }
    })();
    // 09-12: the RANDOM 20-80s gap is a DeepSeek anti-ban measure (owner rule:
    // "to make it seem less botted"). Gemini is a different account on a
    // different host and needs no such padding — applying it there only added up
    // to 80s to every gemini send on top of its own latency, which is what made
    // the engine's lane budget expire (measured: `gemini failed (timeout after
    // 200s)` while the gateway was still generating). Keep the single-thread
    // mutex for gemini; drop the random padding.
    const gap = usesDeepSeek() ? nextSendGapMs() : 0;
    const waitMs = Math.max(0, lastSendAt + gap - Date.now(), sharedWaitMs);
    if (waitMs > 0) {
        console.log(`⏱ send gate: waiting ${waitMs}ms (random ${gap}ms gap this send, per ACCOUNT ${WEBCHAT_ACCOUNT} — the DS lanes are separate accounts)`);
        await sleep(waitMs);
    }
    lastSendAt = Date.now();
    try { fs.writeFileSync(SHARED_SEND_FILE, String(lastSendAt)); } catch { /* non-fatal */ }
    try {
        // Time the model's own turnaround. A failed send is NOT recorded — it
        // measures our timeout or a dead renderer, not the webchat's speed, so
        // folding failures in would make the average describe the failures.
        const _latencyStart = Date.now();
        const r = await sendPrompt(msg, defs);
        recordLatency(Date.now() - _latencyStart);
        await jevCheckReply(msg, r);
        lastReqBodyChars = await getReqBodyChars();
        // 08-14 EXPERT-SWAP PIN: the send swapped an instant thread for a
        // fresh EXPERT one — pin the new thread for every respawn path (same
        // as the context-handoff swap, including the supervisor restart).
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
        // 09-19: key on the CLASS of failure, not on the wording of the message.
        // This gate used to test /Timed out/ alone, but a stall throws
        // "Webchat stalled: no new output for 120s ..." - a string with no "Timed out" in it -
        // so the retry was UNREACHABLE for the exact failure it exists for. Measured over 12h:
        // 18 stalls on :8080 against 12 retry banners, and the engine burned its full 480s
        // budget on every stall the retry never reached. browser.js now tags the error;
        // the message test stays as a fallback for any other site that throws.
        // 09-23: the fallback also covers a transient upstream overload
        // ("Server busy ... generation_timeout"), which browser.js tags as retryable
        // at the source — this pattern exists only for a site that throws it untagged.
        // A throttle is excluded here on purpose: it is handled as a cooldown below,
        // and resending it would deepen the limit.
          const _retryable = !!e.retryable
              || (/Timed out|stalled: no new output|Requesting main frame too early|server busy|generation_timeout/i.test(String(e.message))
                  && !RATE_LIMIT.isRateLimitText(String(e.message)));
        if (sendRetriesLeft > 0 && _retryable) {
            sendRetriesLeft--;
            console.log(`⏱ send timed out${e.partialAnswerChars != null ? ` (partial answer was ${e.partialAnswerChars} chars)` : ''} — resending with a RETRY banner`);
            const _retryStart = Date.now();
            const r = await sendPrompt(
                '### RETRY (the previous message may not have reached you — here it is again)\n' + msg,
                defs
            );
            recordLatency(Date.now() - _retryStart);
            lastReqBodyChars = await getReqBodyChars();
            return r;
        }
        throw e;
    }
    } finally {
        releaseDeepSeekLock();
    }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

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

// The paid upstream is FLASH-ONLY (owner rule, after a pro-model burn). Any other
// model name reaching the paid proxy is refused before a request is made, so a
// caller's typo or a "best model" default can never spend on a pricier tier.
const UPSTREAM_ALLOWED_MODELS = new Set(
    String(process.env.UPSTREAM_ALLOWED_MODELS || 'deepseek-v4-flash')
        .split(',').map((m) => m.trim()).filter(Boolean)
);
function refuseUnlistedUpstreamModel(body, res) {
    const m = body && typeof body.model === 'string' ? body.model : '';
    if (UPSTREAM_ALLOWED_MODELS.has(m)) return false;
    console.log(`⛔ paid-upstream model "${m}" refused (allowed: ${[...UPSTREAM_ALLOWED_MODELS].join(', ')})`);
    res.status(403).json({
        type: 'error',
        error: {
            type: 'permission_error',
            message: `model "${m}" is not allowed on the paid upstream (allowed: ${[...UPSTREAM_ALLOWED_MODELS].join(', ')})`,
        },
    });
    return true;
}

function isWebchatModel(body) {
    const m = body && typeof body.model === 'string' ? body.model : config.modelName;
    // 09-22 A3: 'anymodel' and 'webchat' are the Codex-friendly aliases (no slash
    // — Codex rejects provider/model syntax it does not know). All three route to
    // the tab.
    if (m === config.modelName || m === 'anymodel' || m === 'webchat') return true;
    // 09-24: a harness names the model the way ITS provider layer dictates, and the
    // request body carries that name — not ours. opencode resolves its config entry
    // `provider: webchat, models: { deepseek }` to the id `webchat/deepseek` for display
    // but SENDS `deepseek`, so every request missed this match and was proxied to the
    // real upstream, answering "Authentication Fails (auth header format should be
    // Bearer sk-...)". This gateway serves exactly ONE webchat, so its own name's last
    // segment is an unambiguous alias for it.
    const bare = String(config.modelName || '').split('/').filter(Boolean).pop();
    if (bare && m === bare) return true;
    // 09-24: every toggle COMBINATION is published as its own model id, so picking a
    // model is how an agent changes the webchat's own configuration. See
    // webchat-models.js — webchat/deepseek/deepthink+search and friends.
    return WEBCHAT_MODELS.parse(m) !== null;
}

// Turn the REQUESTED MODEL into the webchat's toggle state.
//
// This is the point of publishing combinations as model ids: a harness can only pick
// a model, so picking one is how it flips a chip. An UNKNOWN toggle is refused loudly
// — silently continuing would let the agent believe it changed something it did not.
let _lastModelId = null;

async function applyModelSelection(body) {
    const raw = body && typeof body.model === 'string' ? body.model : '';
    const parsed = WEBCHAT_MODELS.parse(raw);
    if (!parsed || parsed.unknownSite) return null;
    if (parsed.unknown && parsed.unknown.length) {
        const e = new Error(`unknown toggle(s) "${parsed.unknown.join(', ')}" in model "${raw}"`);
        e.statusCode = 400;
        throw e;
    }
    const state = WEBCHAT_MODELS.toggleStateFor(parsed.site, parsed.toggles);
    if (browser && typeof browser.setRequestToggles === 'function') {
        browser.setRequestToggles(state, parsed);
    }
    console.log(`🎛  model "${raw}" -> ${parsed.label} ${JSON.stringify(state)}`);

    // A toggle baked into the thread (ChatGPT's Think, Freebuff's effort) only takes
    // effect on a fresh chat. Do that ONCE per model CHANGE — not on every request —
    // and carry the conversation across so the switch costs no context.
    const changed = _lastModelId !== raw;
    _lastModelId = raw;
    if (parsed.requiresNewChat && changed && browser && typeof browser.carryContextToNewChat === 'function') {
        console.log(`🔄 "${raw}" needs a fresh thread — summarising and reopening`);
        await browser.carryContextToNewChat();
    }
    return parsed;
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
//
// The credential is an explicit argument, never a default. This used to attach
// UPSTREAM_ANTHROPIC.token — the PAID DeepSeek key — to EVERY proxied request,
// including the WEBCHAT_ROUTES targets (OmniRoute on :20128, the per-webchat
// gateways), so the paid key was sent to OmniRoute on every "omniroute" pick
// even though the comment beside that call says "Never the paid key on this
// route". Only the paid-upstream call sites pass { token }; a route gets none.
async function proxyTo(req, res, upstreamBase, path, body, { token = '' } = {}) {
    try {
        const headers = {
            'content-type': 'application/json',
            'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        };
        if (token) {
            headers['x-api-key'] = token;
            headers.authorization = `Bearer ${token}`;
        }
        const resp = await fetch(`${upstreamBase}${path}`, {
            method: 'POST',
            headers,
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
if (config.apiToken) {
    app.use((req, res, next) => {
        if (req.headers.authorization !== `Bearer ${config.apiToken}`) {
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
const WEBCHAT_PREAMBLE =
    'You are driving an automated tool harness. A machine parses every reply — nobody reads them. ' +
    'You never plan out loud, never ask permission, never summarise: you act. Reply in ENGLISH only, ' +
    'whatever language the history uses.';

// ── Tool-call size cap ──────────────────────────────────────────────────
// The chat renderer truncates very long messages, which corrupts fenced JSON
// mid-escape (observed: huge write_file content returned mangled and the
// parse died on the first broken '{'). Over this limit the model gets the
// TOO_BIG error and must resend in chunks instead of the call executing.
const MAX_TOOL_CALL_CHARS = parseInt(process.env.MAX_TOOL_CALL_CHARS || '60000', 10);

const TOO_BIG_MSG =
    `### TOOL CALL TOO BIG\nYour last call was over ${MAX_TOOL_CALL_CHARS} characters (the chat truncates ` +
    'large messages, which corrupts the JSON). Split the work: write the file in parts with run_bash ' +
    "`cat > path <<'C1'` then `cat >> path <<'C2'` (write_file has NO append — it overwrites), then " +
    '`cat path` to verify. Resend the same call in chunks, keeping every call well under the limit.';

const WEBCHAT_FORMAT =
    '### RESPONSE FORMAT (STRICT)\n' +
    'Every reply is exactly ONE fenced tool call, optionally preceded by ONE short 💬 line:\n' +
    '💬 <one sentence: what you are about to do and why>\n' +
    '```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'The fence is MANDATORY — without it this chat renders your backticks as formatting and corrupts the JSON.\n' +
    'A reply with no tool call, or more than one, is rejected and sent back to you.\n' +
    'Finish with submit_answer carrying your final summary; that ends the turn. For a simple question or a ' +
    'greeting, submit directly with no tool calls.\n' +
    // ── FINISH THE WHOLE TASK (owner, 09-24: "harden it to never leave a task unfinished,
    //    and to always do all the work"). Positioned here on purpose: this block goes LAST,
    //    after the user request, which is the most salient slot the model sees. Every rule
    //    below is written against a failure that was MEASURED on this lane, not a theory.
    '### FINISH THE WHOLE TASK\n' +
    'Read the task as a CHECKLIST, not a sentence. Every clause counts — the edge cases, the ' +
    'things introduced with "and also", and especially anything you were told NOT to do. If the task ' +
    'names five changes, five changes must exist. Doing three and summarising is failure.\n' +
    'Work the task until it is completely done AND verified. Do not stop at the first error: read the ' +
    'real error, change your approach, and continue. Do not stop to ask permission — the instruction ' +
    'WAS the permission. Do not hand back a plan when the work was what was asked for.\n' +
    'If part of it is genuinely impossible, finish everything that IS possible first, then say exactly ' +
    'what could not be done and why. Never silently drop part of a task.\n' +
    'NEVER CLAIM WORK YOU DID NOT DO. If no tool call in this turn changed something, you have not done ' +
    'the work — and saying "completed successfully" after only reading files is worse than an honest ' +
    'failure. Report what actually happened, not what you intended.\n' +
    'NEVER LEAVE IT BROKEN. If a change needs a matching brace, bracket, paren or JSX closer, make it ' +
    'ONE edit that covers the whole block — never split it in two, because the file is unbuildable in ' +
    'between and the build failure then looks like someone else\'s bug.\n' +
    // ── EDITING. Measured: the lane was asked for three small edits to a 297-line file, rewrote
    //    nothing, ran the build and reported success — because write_file was its only tool and
    //    emitting 297 lines as one JSON string is not something a model reliably does.
    '### EDITING\n' +
    'For a small change use edit_file (exact old text → new text). Do NOT rewrite a whole file to ' +
    'change a few lines — that is where you make mistakes. Match the file\'s existing style and ' +
    'indentation exactly. Change only what the task names: if you notice something else worth fixing, ' +
    'mention it in your summary instead of changing it.\n\n' +
    'JSON: string values must be valid JSON — escape " as \\" and backslash as \\\\. Use \\n for newlines, never ' +
    'raw newlines inside a string value.\n' +
    'Tool calls must stay under ' + MAX_TOOL_CALL_CHARS + ' characters — split large content across calls.\n';

const CONV_PREAMBLE =
    'You are a coding assistant in an interactive session. Reply in ENGLISH only. ' +
    'Answer conversation directly; before any tool call, say in one 💬 line what you are about to do.';

const CONV_FORMAT =
    '### RESPONSE INSTRUCTIONS (STRICT)\n' +
    '1. Conversation (a greeting, a question about the code) → answer directly in plain text, no tools.\n' +
    (config.narration
        ? '2. Tools (read files, run commands, edit code) → start with ONE 💬 line saying what you are about to ' +
          'do and why, then the fenced tool call:\n' +
          '<one sentence>\n' +
          '```json\n{"tool":"<name>","params":{...}}\n```\n'
        : '2. Tools → emit the fenced tool call directly, no 💬 line:\n' +
          '```json\n{"tool":"<name>","params":{...}}\n```\n') +
    '3. One tool call per reply, then wait for the result. Keep working until the task is done and verified, ' +
    'then give your final summary.\n';

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
    // 09-14: PASSTHROUGH_FORMAT means the CALLER shipped a complete contract
    // (the oculus step engine's {"edits":[...]}). Offering the interactive tool
    // set on top of it is a competing instruction the model obeys: measured live
    // the DS lane answered {"tool":"see_next_chunk",...} / {"tool":"read_file",...}
    // for 13+ rounds and the engine read every one as "no edits", so no step could
    // commit (throughput 43/h -> 0/h). With a caller-supplied contract there is
    // nothing for the interactive tools to do — return an empty set so the model
    // answers the contract directly.
    // 09-16 (owner): "their supposed to have a next chunk tool call."
    //
    // The engine hands a lane a TRUNCATED view of any file over 24000 chars
    // (execute.file_text's size_cap). A lane that cannot call see_next_chunk can never
    // reach the code the step names, so it answers "the file view ends mid-function" /
    // "not present in the provided file contents" and burns its rounds into yellow.
    // Measured on the yellow pile: 34 yellows say exactly that, 8 of them on target
    // files of 31K-311K chars (engine.rs 311,277 / emulator.rs 140,166 / fill.rs 60,485)
    // - structurally unfixable without this tool.
    //
    // So offer the CONTENT-FETCH tools even in passthrough mode. The 09-14 outage was
    // not caused by tools existing: it was the model free-running through
    // list_dir / write_file / submit_answer for 13+ rounds. Keep the set to the two
    // read-only tools, and bound the loop at the call site below.
    if (config.passthroughFormat) {
        return getExecutableToolDefinitions().filter(
            (t) => t.name === 'read_file' || t.name === 'see_next_chunk');
    }
    // 09-22 A2: research-only / no-tools. The model is offered NO work tools, only
    // submit_answer, so a research or plain-English task answers directly instead of
    // being driven through file tools it does not need.
    if (config.noTools) {
        return [SUBMIT_TOOL_DEF];
    }
    // 09-22 A1: advertise the EXECUTABLE set, not the full catalogue. A tool whose
    // requirement is unmet (search_web without a key or native search, run_bash with
    // the gate off, …) is dropped here so the model can never try it and loop.
    // External MCP tools (mcp.js) are merged in, already fail-open filtered.
    return [...getExecutableToolDefinitions(), ...externalToolDefs(), SUBMIT_TOOL_DEF];
}

// The external MCP tool schemas, discovered once at first request. Kept separate
// so the synchronous TOOL_SECTION_TOKENS estimate below does not need them.
let externalDefs = [];
let mcpDiscovered = false;
function externalToolDefs() {
    return externalDefs.map((d) => ({ ...d }));
}

async function ensureMcpDiscovered() {
    if (mcpDiscovered) return;
    mcpDiscovered = true;
    if (!mcpPool || !mcpPool.configured) return;
    try {
        await mcpPool.discover();
        externalDefs = mcpPool.externalDefinitions();
    } catch (e) {
        console.log('⚠️ MCP discovery failed:', String(e.message).slice(0, 100));
        externalDefs = [];
    }
}

// A request that ended WITHOUT a usable answer.
//
// These used to be RETURNED as the answer text ("[⚠️ webchat model did not submit a
// final answer within the round budget] ...") and the HTTP layer wrapped them as a
// normal completion: 200 + stop_reason end_turn / finish_reason stop. A caller that
// did not grep for the marker string — the orchestrator, a subagent job, the swarm —
// recorded the step as DONE over code nothing had touched. A failure is now thrown,
// and every API surface turns it into a real error: HTTP 502 before headers, or an
// error-terminated stream (stop_reason "error") once streaming has started.
class HarnessIncomplete extends Error {
    constructor(outcome, message) {
        super(message);
        this.name = 'HarnessIncomplete';
        this.outcome = outcome; // round_budget | no_tool_json | malformed | spiral | empty | unverified
    }
}

// Is a submit_answer credible?
//
// Measured: a real run executed ZERO tools and then answered
//   "Remediation plan execution completed successfully. All active waves and steps
//    have been addressed, verified, and logged in accordance with the specifications."
// The gateway returned HTTP 200 with that text, so the caller could not tell a
// finished job from a fabricated one. The gateway cannot know whether the model is
// lying, but it does know nothing ran, and saying so is the difference between a
// caller being misled and being informed.
//
// Deliberately narrow: only when work tools were OFFERED and none ran. A direct
// answer that needed no tools is left alone, so conversation callers are unaffected.
const UNVERIFIED_MARKER = '[⚠️ no tools were run in this turn — this answer contains no work the harness could verify]\n\n';

// Does the answer CLAIM that work was done?
//
// This is the signal the guard actually needs, and the first version did not have it:
// it marked ANY submit that followed zero tool calls, so a plain question answered
// directly — "What is 2+2?" -> "Four" — came back wearing a warning that no work had
// been verified. A guard that fires on a correct answer is a guard that lies in the
// other direction, which is the same defect it exists to catch.
//
// The real failure is narrower and specific: a submit that ASSERTS completed work
// while nothing ran. That is a claim the harness can contradict, so it does.
const WORK_CLAIM_RE = new RegExp(
    '\\b(completed|complete|finished|done|verified|verifies|implemented|executed|applied|' +
    'fixed|resolved|addressed|tests? (pass|passed|are passing)|all (steps|waves|tasks|tests)|' +
    'successfully|no (remaining|further) work)\\b', 'i');

function claimsWorkDone(text) {
    return WORK_CLAIM_RE.test(String(text || ''));
}

// Tools that CHANGE something on disk. Reading and listing are work, but they cannot
// make a claim about a change true.
//
// edit_file belongs here for the same reason write_file does. Missing it would be a FALSE
// POSITIVE in the other direction: a run that made its only change with edit_file would
// score mutationsRun=0, and an entirely honest "updated the file" answer would be marked
// unverified. Every new writing tool must be added here as well as to the offered set.
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'edit_memory']);

// A bash command that changes a repository. Deliberately narrow: a false positive adds
// a warning to an honest answer, so only unambiguous verbs count.
const MUTATING_BASH_RE = /(^|[;&|]\s*)(git\s+(commit|push|merge|rebase|cherry-pick|add)|rm\s|mv\s|cp\s|sed\s+-i|tee\s|>>?\s*\S)/;

// An answer that says the work LANDED. Distinct from claimsWorkDone, which matches any
// "done" — this is specifically about changes being written or committed somewhere.
const MUTATION_CLAIM_RE = new RegExp(
    '\\b(committed|pushed|wrote|written|saved|applied|created|updated|modified|edited|' +
    'hashed|installed|deployed|migrated|patched|replaced|removed|deleted|added)\\b', 'i');

function claimsMutation(text) {
    return MUTATION_CLAIM_RE.test(String(text || ''));
}

// An answer that says the TESTS pass. Checked against what the test commands in
// this turn actually returned (case 3 below).
const TESTS_PASS_CLAIM_RE = /\b(tests?|suite|pytest|specs?)\b[^.\n]{0,40}?\b(pass(es|ed|ing)?|green|succeed(s|ed)?)\b/i;
// A run_bash command that runs a test suite.
const TEST_COMMAND_RE = /(^|[\s;&|(])(pytest|py\.test|npm (run )?test|npx (jest|vitest|mocha)|node --test|jest|vitest|mocha|cargo test|go test|make (test|check)|tox|nox|python3? -m (pytest|unittest))(?=$|[\s;&|)])/;

function claimsTestsPass(text) {
    return TESTS_PASS_CLAIM_RE.test(String(text || ''));
}

function markUnverifiedSubmit(text, { offeredWorkTools, workToolsRun, mutationsRun = null, testRuns = null }) {
    const answer = String(text || '');

    // Case 3 (checked first — it is the most specific): the answer says the tests pass, but no test command succeeded in this
    // turn — none ran, or the LAST one failed. Measured shape: `pytest` exits 1, the
    // model reads the tail, and submits "fixed; all tests pass".
    if (offeredWorkTools && testRuns && claimsTestsPass(answer) && !(testRuns.ran > 0 && testRuns.lastOk)) {
        const why = testRuns.ran > 0
            ? 'the last test command in this turn FAILED'
            : 'no test command was run in this turn';
        return {
            marked: true,
            text: `[⚠️ the answer says the tests pass, but ${why}. Verify before trusting it.] ` + answer,
            reason: 'tests_claim',
        };
    }

    // Case 1: nothing ran at all, and the answer claims the job was done.
    // A bare answer asserts nothing, so there is nothing to contradict.
    if (offeredWorkTools && workToolsRun === 0 && claimsWorkDone(answer)) {
        return { marked: true, text: UNVERIFIED_MARKER + answer, reason: 'no_work' };
    }

    // Case 2: the answer says it CHANGED something (committed, pushed, wrote, hashed)
    // but no tool that can change anything was called. This is the failure the
    // zero-tool check cannot see, and it is the one that actually happened: a run made
    // 25 read-only calls — read_file, list_dir, run_bash pytest — then submitted
    // "changes committed and pushed … session tokens hashed, cost routes guarded".
    // `git log` in both repositories showed no commit, no such code, and no diff. The
    // caller had a confident summary of work that does not exist.
    //
    // Read-only work is not evidence of a change, so the two counts are kept apart:
    // workToolsRun says "it did something", mutationsRun says "something can differ now".
    if (
        offeredWorkTools &&
        mutationsRun === 0 &&
        workToolsRun > 0 &&
        claimsMutation(answer)
    ) {
        return {
            marked: true,
            text:
                '[⚠️ no file was written and no command was run that changes anything — this answer ' +
                'describes changes, but nothing in this turn could have made one. Verify before trusting it.] ' +
                answer,
            reason: 'mutation_claim',
        };
    }

    return { marked: false, text: answer };
}

// Route a tool call to the right executor: an external MCP tool goes to the pool,
// everything else to the harness's own tools.js. Both fail soft (a bad call
// returns {success:false,...}, never throws out of the loop).
async function runTool(name, args, ctx) {
    if (mcpPool && mcpPool.has(name)) {
        return mcpPool.execute(name, args);
    }
    return executeTool(name, args, ctx);
}

// 09-22 B3: compact a tool result for the MODEL-facing receipt (the tab follow-up
// that becomes the model's next prompt). Errors pass through untouched, always —
// a truncated stack trace is a wrong answer (the compactor's rule 1).
function maybeCompactResult(call, result) {
    if (!config.toolCompactor) return result;
    // read_file is EXEMPT, and this is a data-loss guard, not a preference.
    //
    // read_file already caps itself at 200K chars and flags it (truncated:true +
    // totalLength). Compacting it further to 10K loses the middle of a file with no
    // truncation flag at all, so the model cannot tell a short file from a clipped
    // one — and a model that then writes the file back destroys everything it did
    // not see. Compaction exists to stop a 4MB bash flood, not to silently rewrite
    // source the user asked to be read.
    if (call.toolName === 'read_file') return result;
    const { result: compacted, compacted: did } = compactor.compactResult(result, config.compactor);
    if (did) console.log(`🗜️ compacted ${call.toolName} result (maxText ${config.compactor.maxText})`);
    return compacted;
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
            'Do NOT execute any tools and do NOT call read_file, list_dir or run_bash. ' +
            (config.allowPlainText
                ? 'Reply with a brief, friendly greeting in plain text.\n'
                : 'Deliver a brief, friendly greeting through submit_answer — one fenced call, no tools.\n');
    }
    return '';
}

// 09-21 BUGFIX (reported): the fresh-chat reset is performed at the REQUEST
// BOUNDARY only, by this wrapper, and never from inside the tool loop.
// Counting happens in countedSend(); acting on the count happens here, once per
// client request, before the conversation starts. requestInFlight is raised for
// the whole request (cleared in finally on every path) so a nested attempt can
// never navigate the tab out from under a live response - which is what broke
// multi-tool Claude Code requests ("Server error mid-response").
async function handleRequest(systemText, userPrompt, toolDefs, onProgress, isAborted) {
    requestInFlight = true;
    try {
        try {
            await maybeResetThreadAtBoundary('request start');
        } catch (e) {
            console.warn('⚠️ boundary fresh-chat open failed:', e.message);
        }
        return await handleRequestInner(systemText, userPrompt, toolDefs, onProgress, isAborted);
    } finally {
        requestInFlight = false;
    }
}

async function handleRequestInner(systemText, userPrompt, toolDefs, onProgress, isAborted) {
    // PASSTHROUGH_FORMAT: the caller ships a complete, self-contained contract in
    // its system text (the oculus step engine's {"edits":[...]}). This gateway
    // must then add NOTHING — every block it used to wrap around it was a
    // competing instruction, and the model obeys the most recent one:
    //   ### SYSTEM INSTRUCTION + CONV_PREAMBLE  -> "you are a coding assistant in
    //       an interactive terminal session; state what you are about to do" —
    //       invites prose and narration.
    //   CONV_FORMAT / WEBCHAT_FORMAT            -> "reply in friendly plain text"
    //       or "call submit_answer" — a different output schema entirely.
    //   continueDirective                       -> "reply with your NEXT tool call
    //       JSON ... or submit_answer" — a third schema.
    //   greetingDirective                       -> "reply in plain text, no tools".
    // Stacked around a strict JSON contract, these are why gemini answered
    // "Task completed successfully." and why the engine's steps never landed.
    // A caller that defines its own contract gets its own contract, verbatim.
    let prompt;
    // 09-22 B4: the persistent memory file rides into the prompt so what the user
    // or the model wrote is actually in effect. Bounded by memory.js.
    const memoryBlock = config.memoryEnabled ? memory.memoryBlock() : '';
    if (config.passthroughFormat) {
        prompt = systemText ? `${systemText}\n\n${userPrompt}` : userPrompt;
        if (memoryBlock) prompt = `${memoryBlock}\n${prompt}`;
        // 09-16 (owner): "their supposed to have a next chunk tool call." Offering the
        // tools in buildExecutableToolDefs() is NOT enough - the passthrough prompt is
        // just system+user, with no tool preamble, so the model does not know they
        // exist. Measured: asked to read a file past the engine's 24000-char cap, the
        // lane answered "no see_next_chunk tool is available to me in this session".
        // Name the two read tools and the exact call shape, and nothing else - the
        // caller's edit contract stays the only thing the answer must satisfy.
        if (parseInt(process.env.PASSTHROUGH_FETCH_ROUNDS || '3', 10) > 0) {
            prompt += '\n\n### TOOLS\n'
                + 'Large files are shown to you as windows with the omitted ranges marked, '
                + 'so the code you need may be outside the window you were given. If that '
                + 'happens, you may fetch more instead of giving up: reply with EXACTLY '
                + 'one of these JSON objects and NOTHING else:\n'
                + '{"tool":"see_next_chunk","params":{"path":"<the path you were given>"}}\n'
                + '{"tool":"read_file","params":{"path":"<the path you were given>"}}\n'
                + 'You will be given the content it returns, and then you must answer with '
                + 'your edit contract. Only use this when the code you need is genuinely '
                + 'not in the content above.';
        }
    } else {
        const preamble = config.allowPlainText ? CONV_PREAMBLE : WEBCHAT_PREAMBLE;
        prompt = `### SYSTEM INSTRUCTION\n${preamble}\n\n`;
        if (memoryBlock) prompt += `${memoryBlock}\n`;
        if (systemText) prompt += `${systemText}\n\n`;
        prompt += `### USER MESSAGE\n${userPrompt}\n\n`;
        prompt += config.allowPlainText ? CONV_FORMAT : WEBCHAT_FORMAT;
        prompt += continueDirective(userPrompt);
        prompt += greetingDirective(userPrompt);
        prompt += `### RESPONSE\n`;
    }

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

    // FRESH_CHAT_PER_SEND: gemini's send is reliable on a new chat and flaky on a
    // conversation page — the first call after a fresh chat answers in ~6s, every
    // later one times out with the prompt still in the composer. Open a new chat
    // before each send so the lane always starts from the state that works.
    // Costs a navigation; the engine is throughput-bound on the model anyway.
    if (process.env.FRESH_CHAT_PER_SEND === 'true') {
        try {
            await openNewChat();
            await sleep(600);
        } catch (e) {
            console.log('⚠️ fresh-chat-per-send failed (continuing on current thread):', String(e.message).slice(0, 80));
        }
    }

    let response = await countedSend(injectMainReplies(prompt), toolDefs);

    // 09-14: a caller contract is answered verbatim, NOT driven through the
    // interactive loop - the model free-ran through list_dir/submit_answer for 13+
    // rounds, the engine read every one as "no edits", and step commits went
    // 35/h -> 0/h for 90 minutes.
    //
    // 09-16 (owner): "their supposed to have a next chunk tool call." The exception is
    // the CONTENT-FETCH tools: a lane handed a truncated file must be able to pull the
    // next chunk. Bounded hard (PASSTHROUGH_FETCH_ROUNDS, default 3) and restricted to
    // read_file / see_next_chunk, so every reply that is not a fetch is still returned
    // verbatim and the 09-14 free-run cannot come back.
    if (config.passthroughFormat) {
        const _fetchRounds = Math.max(0, parseInt(process.env.PASSTHROUGH_FETCH_ROUNDS || '3', 10));
        let _text = response;
        for (let _i = 0; _i < _fetchRounds; _i++) {
            // parseToolCalls returns {prose, toolCalls: [{toolName, args}]} — an OBJECT,
            // not an array. Measured by test: calling .find() on it threw
            // "_calls.find is not a function" as a 500 on every passthrough request.
            let _calls = [];
            try { _calls = (parseToolCalls(_text) || {}).toolCalls || []; } catch { _calls = []; }
            const _fetch = _calls.find((c) => c && (c.toolName === 'read_file' || c.toolName === 'see_next_chunk'));
            if (!_fetch) {
                if (!String(_text || '').trim()) throw new HarnessIncomplete('empty', 'webchat model gave no reply');
                return _text;
            }
            // The engine writes REPO-RELATIVE paths into its prompts
            // ("execution/signals.py"), but sandbox.checkPath resolves a relative path
            // against the GATEWAY's cwd (/home/roni/Roni_workspace/webchat-api) and
            // denies it. Measured directly against the tool:
            //   "execution/signals.py"                        -> DENIED, 268 chars
            //   "/home/roni/.../oculus/execution/signals.py"  -> 20,000 chars of content
            // So a lane that followed the TOOLS instructions verbatim would always be
            // refused, and the tool would be useless to the exact caller it was built
            // for. Resolve a relative path against the sandbox's allowed roots first.
            let _args = _fetch.args || {};
            try {
                const _fs = require('fs');
                const _path = require('path');
                const _roots = require('./src/tools/sandbox').roots || [];
                if (_args.path && !_path.isAbsolute(_args.path)) {
                    for (const _root of _roots) {
                        const _cand = _path.join(_root, _args.path);
                        if (_fs.existsSync(_cand)) { _args = { ..._args, path: _cand }; break; }
                    }
                }
            } catch { /* fall through with the original args */ }
            let _res;
            try {
                _res = await runTool(_fetch.toolName, _args, { threadId: config.webchatUrl || null });
            } catch (e) {
                console.log(`⚠️ passthrough fetch (${_fetch.toolName}) failed: ${String(e).slice(0, 120)}`);
                return _text;
            }
            const _payload = JSON.stringify(_res);
            console.log(`📎 passthrough fetch ${_i + 1}/${_fetchRounds}: ${_fetch.toolName} -> ${_payload.length} chars`);
            if (_payload.length <= 200) return _text;
            // Never slice the JSON STRING: a byte cut lands mid-token and hands the
            // lane invalid JSON it cannot parse. Measured: read_file on
            // rust/execution/tests/matching_engine.rs (552240 chars) returns a
            // 207109-char payload, and slicing that to 60000 chops it mid-object.
            // Truncate the CONTENT field instead, and say so, so the result stays
            // valid JSON the model can actually read.
            let _body;
            // The fetch feedback is INJECTED into a re-prompt, so its size lands
            // straight on top of the caller's own prompt budget. Measured 09-18 on
            // the three deepseek webchats: read_file returned 38-141K chars, the
            // re-prompt went out at 42,494 / 62,202 / 62,059 chars against a lane
            // cap of 20000, and the DS tab HUNG on every one of those sends (4
            // engine timeouts at exactly its budget in a 15-min window, 32
            // worker-minutes burned on ONE lane). The whole point of chunking is
            // that a lane can fetch AGAIN for the next part, so a smaller default
            // is strictly better here.
            const _fetchMax = Math.max(2000, parseInt(process.env.PASSTHROUGH_FETCH_MAX_CHARS || '12000', 10));
            if (_res && typeof _res.content === 'string') {
                const _raw = _res.content;
                const _cut = _raw.slice(0, _fetchMax);
                _body = JSON.stringify({
                    ..._res,
                    content: _cut,
                    truncated: _res.truncated || _cut.length < _raw.length,
                    returnedChars: _cut.length,
                    totalChars: _raw.length,
                    ...(_cut.length < _raw.length
                        ? { note: `content cut at ${_cut.length} of ${_raw.length} chars; fetch again for the next part` }
                        : {}),
                });
            } else {
                _body = _payload.slice(0, _fetchMax);
            }
            _text = await countedSend(
                'TOOL RESULT for ' + _fetch.toolName + ' (the real file content you asked for):\n'
                + _body
                + '\n\nNow continue the original task and reply with the JSON edit contract, and nothing else.',
                toolDefs);
        }
        return _text;
    }
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
    let malformedRounds = 0;  // CONSECUTIVE broken tool-JSON attempts (resets on a good parse)
    let malformedRetries = 0; // automatic pauses+retries taken this request (bounded by malformedMaxRetries)
    let narrationNudged = false; // strict mode: send_message narration taught once per request
    let emptyAnswerNudged = false; // 08-16: empty submit_answer retried once before the placeholder
    // Work tools actually EXECUTED in this request. send_message and the submit
    // aliases are conversation, not work, so they do not count.
    //
    // Why this exists: measured on a real run, the model spent six rounds emitting
    // prose and malformed envelopes, was asked to wrap up, and then called
    // submit_answer with
    //   "Remediation plan execution completed successfully. All active waves and
    //    steps have been addressed, verified, and logged..."
    // having executed ZERO tools. The gateway returned HTTP 200 and that paragraph
    // as the answer, so the caller had no way to tell a completed job from a
    // fabricated one — the plan script reported success and nothing had happened.
    // A submit that follows no tool work is not proof of anything, and the gateway
    // is the only layer that can see it, so it says so.
    let workToolsRun = 0;
    // Work that can actually CHANGE something. workToolsRun counts reads too, so it
    // cannot answer "did this run alter any state?" — see markUnverifiedSubmit case 2.
    let mutationsRun = 0;
    // Test commands run this turn, and whether the most recent one exited 0.
    const testRuns = { ran: 0, lastOk: false };
    let wrapUpSent = false; // 09-13: near the round budget, demand a final submit_answer
    let spiralStrikes = 0; // 09-13: repeated reasoning loops in the tab
    let lastToolInfo = null;  // most recent executed call, for the handoff doc

    for (let round = 0; round < config.maxToolRounds; round++) {
        // 09-13 WRAP-UP (reported: "webchat model did not submit a final answer
        // within the round budget — happening almost every prompt"). Running out
        // of rounds used to hand the caller a bare error marker and throw away
        // all the work the model had done. Spend the LAST few rounds asking for
        // the summary instead: the model has a complete task at this point, it
        // only needs to be told to stop working and report.
        if (!wrapUpSent && round >= config.maxToolRounds - Math.max(1, config.wrapUpRounds)) {
            wrapUpSent = true;
            console.log(`⏳ round budget nearly spent (${round}/${config.maxToolRounds}) — demanding the final submit_answer`);
            onProgress?.({ type: 'rejected', text: 'round budget nearly spent — demanding the final answer now' });
            response = await countedSend(
                'You are out of time. STOP calling tools. Deliver your FINAL answer NOW as a single fenced ' +
                '```json\n{"tool":"submit_answer","params":{"text":"<what you did, what you verified, and anything left undone>"}}\n``` ' +
                'Summarise the real work you completed and any step you could not finish. Do not start new work.',
                toolDefs);
            continue;
        }
        // ── ANTI-SPIRAL (09-13) ────────────────────────────────────────────
        // The model can collapse into a reasoning loop ("Let me go." x40) and
        // burn every remaining round without doing work. Detect it here: the
        // FIRST time, redirect the model back to the task; if it loops again,
        // stop feeding the tab and hand the caller the warning at the top of the
        // answer instead of a round-budget error.
        if (config.antiSpiral) {
            const spiral = ANTI_SPIRAL.detectSpiral(response, { narration: config.narration });
            if (spiral) {
                spiralStrikes++;
                console.log(`🛑 anti-spiral: ${ANTI_SPIRAL.describe(spiral)} (strike ${spiralStrikes}) round ${round + 1}`);
                onProgress?.({ type: 'rejected', text: 'anti-spiral: generation paused — ' + ANTI_SPIRAL.describe(spiral) });
                if (spiralStrikes >= 2) {
                    throw new HarnessIncomplete('spiral', ANTI_SPIRAL.spiralBanner(spiral) + exhaustedMarker('', response));
                }
                response = await countedSend(ANTI_SPIRAL.spiralRedirect(spiral), toolDefs);
                continue;
            }
        }
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
            proseRounds = 0;
            const call = parsed.toolCalls[0];
            // The model's intent message rides ahead of the tool call — the
            // client sees "what I'm about to do" before the 🔧 line.
            if (parsed.prose) {
                onProgress?.({ type: 'text', text: parsed.prose });
            } else if (call.toolName !== SUBMIT_TOOL && call.toolName !== 'send_message') {
                const autoNarration = `Let me run ${call.toolName} to inspect and perform the requested task.`;
                onProgress?.({ type: 'text', text: autoNarration });
            }

            // 08-13 EVENING (user rule "force it"): a work tool call with NO
            // prose and NO send_message means the model skipped narration —
            // nudge it ONCE per request to send send_message first. (Bounded:
            // one extra round max; the call itself is not lost, the model
            // re-sends it after the send_message.)
            if (
                config.narration &&
                !config.allowPlainText &&
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
            // A submit ENDS the loop, but it is only evidence of a finished job if
            // work actually ran — so it passes through markUnverifiedSubmit first.
            const isSubmit = call.toolName === SUBMIT_TOOL || call.toolName === 'submit_message' || call.toolName === 'task_complete' || call.toolName === 'done';
            if (isSubmit) {
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
                // The rationale lives with markUnverifiedSubmit, so the rule is stated
                // once instead of drifting in two places.
                const offeredWorkTools = !config.noTools && !config.allowPlainText;
                const verdict = markUnverifiedSubmit(final || '', { offeredWorkTools, workToolsRun, mutationsRun, testRuns });
                if (verdict.marked) {
                    // A claim the harness can contradict is a failed request, not an
                    // answer: the caller gets an error it cannot mistake for success.
                    console.log(`⚠️ unverified submit (${verdict.reason}): work=${workToolsRun} mutations=${mutationsRun} tests=${testRuns.ran}/${testRuns.lastOk ? 'ok' : 'failed'}`);
                    onProgress?.({ type: 'rejected', text: `answer rejected as unverified (${verdict.reason})` });
                    throw new HarnessIncomplete('unverified', verdict.text);
                }
                // Never manufacture an answer. This used to fall back to the literal
                // "[webchat model completed the task]" after the one empty-submit nudge,
                // so two empty submits reached the caller as a confident completion.
                if (!String(verdict.text || '').trim()) {
                    throw new HarnessIncomplete('empty', 'webchat model submitted an empty answer twice — no result to return');
                }
                return verdict.text;
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
                const text = String(call.args?.text ?? '');
                if (text) onProgress?.({ type: 'text', text });
                result = { success: true, delivered: true, instruction: 'Message delivered to user. Now proceed with your work tool call (read_file, run_bash, etc.) or deliver final answer via submit_answer.' };
            } else {
                result = await runTool(call.toolName, call.args, { threadId: config.webchatUrl || null });
                // Count only real work: send_message is conversation and the submit
                // aliases end the turn, so neither is evidence the task was touched.
                //
                // Only a call that SUCCEEDED counts. Counting attempts let a turn whose
                // every write was refused by the sandbox (or whose every edit_file missed
                // its old_string) submit "implemented the fix" with mutationsRun=6.
                const ok = !!(result && result.success === true);
                if (ok) workToolsRun++;
                // And separately, whether anything here could have changed state at all.
                // A run_bash only counts when its command actually mutates — `pytest` and
                // `git log` are reads, and treating them as writes is what let
                // "changes committed and pushed" pass unchallenged.
                if (ok && MUTATING_TOOLS.has(call.toolName)) mutationsRun++;
                else if (ok && call.toolName === 'run_bash' && MUTATING_BASH_RE.test(String(call.args?.command || ''))) mutationsRun++;
                if (call.toolName === 'run_bash' && TEST_COMMAND_RE.test(String(call.args?.command || ''))) {
                    testRuns.ran++;
                    testRuns.lastOk = ok;
                }
            }
            // 08-16 (user): stream a readable receipt to the client — the exact
            // command / file / output, not a bare "🔧 toolname" — so anyone
            // watching the webchat knows what just ran. The tab follow-up
            // below carries the full result (belt-capped) for the model.
            if (call.toolName !== 'send_message') {
                onProgress?.({ type: 'text', text: formatToolResultView(call, result, 6000) });
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
                (call.toolName === 'send_message' ? '' : formatToolResultView(call, maybeCompactResult(call, result), config.modelToolResultCap, { forModel: true }) + '\n\n') +
                (config.allowPlainText
                    ? 'Task is NOT complete until every part is done AND verified. Send ONE 💬 line, then your ' +
                      'next fenced tool call. Verify with run_bash (syntax checks, imports, the project tests); ' +
                      'never claim completion for work you have not run. read_file caps at 200K chars ' +
                      '(truncated:true + totalLength) — pass maxLength for a head window. When everything is done ' +
                      'and verified, reply with a fenced submit_answer carrying your final summary.'
                    : 'Task is NOT complete until every part is done AND verified. Continue the work: inspect, ' +
                      'modify, VERIFY with run_bash (syntax checks, imports, the project tests) — never claim ' +
                      'completion for work you have not run. read_file caps at 200K chars (truncated:true + ' +
                      'totalLength) — pass maxLength for a head window. Reply with exactly ONE of these, nothing ' +
                      'else: (a) your next tool call — send_message with a one-line 💬 to speak to the user, or a ' +
                      'work tool — fenced as ```json ... ```; (b) a fenced submit_answer, only if the entire task ' +
                      'is done and verified.');
            response = await countedSend(followUp, toolDefs);
            continue;
        }

        // No tool call in this reply. Did it LOOK like a tool attempt?
        // (a "tool": envelope anywhere, or the renderer's json/Copy/Download
        // chrome glued to an opening brace — raw triple quotes, raw newlines,
        // or a truncated brace made the parse fail). Send it back as a
        // correction — never ship the raw row text to the client.
        //
        // CONVERSATION MODE IS EXEMPT. With ALLOW_PLAIN_TEXT the caller wants
        // the model's raw text (the fix-executor's `{"edits":[...]}` block is
        // exactly this shape) — treating it as a broken tool call made the
        // gateway re-send a correction up to maxToolRounds times and never
        // return, so every engine step burned its full timeout on this lane.
        if (!config.allowPlainText && looksLikeBrokenToolJson(response)) {
            malformedRounds++;
            const reason = describeMalformedJson(response);
            // Log WHAT the parser saw and WHY it failed. Without the reason a reader-side
            // bug (the renderer losing the code block) is indistinguishable from the model
            // never emitting a usable tool call — and the two need opposite fixes.
            console.log(`⚠️ MALFORMED JSON DETECTED (round ${round + 1}, ${malformedRounds}/${config.maxMalformedRounds} in a row) — ${reason}. raw=[${String(response).replace(/\s+/g, ' ').slice(0, 400)}]`);
            onProgress?.({ type: 'rejected', text: `malformed JSON detected (${malformedRounds}/${config.maxMalformedRounds}) — ${reason}` });

            // ── STOP after N consecutive failures, then RETRY BY ITSELF ──────────
            //
            // Measured: a model that emits a broken shape tends to emit the SAME shape
            // again, so correcting forever just burns the round budget and lands in the same
            // place. Stopping is right — but stopping permanently loses a run that a single
            // fresh attempt would often salvage, so a malformed stop pauses and retries on a
            // timer instead of ending the request.
            //
            // The POLICY is the pure `malformedAction` above (all four numbers are
            // CLI-settable): the streak threshold, the delay in SECONDS, the retry cap and
            // the enable switch. This block only performs the verdict.
            const verdict = malformedAction({ malformedRounds, malformedRetries }, config, reason);
            if (verdict.action === 'retry') {
                malformedRetries++;
                console.log(`⏸ ${malformedRounds} malformed JSON replies in a row — pausing ${config.malformedRetryDelaySec}s then auto-retrying (retry ${malformedRetries}/${config.malformedMaxRetries})`);
                onProgress?.({
                    type: 'rejected',
                    text: `malformed JSON ${malformedRounds}x in a row — waiting ${config.malformedRetryDelaySec}s, then retrying (${malformedRetries}/${config.malformedMaxRetries})`,
                });
                if (verdict.waitMs > 0) await new Promise((r) => setTimeout(r, verdict.waitMs));
                // A fresh streak: the retry is a NEW attempt, not a continuation of the one
                // that failed, so it gets the full threshold again.
                malformedRounds = 0;
                response = await countedSend(malformedCorrectionMsg(reason, 1, config.maxMalformedRounds), toolDefs);
                continue;
            }
            if (verdict.action === 'stop') {
                throw new HarnessIncomplete('malformed', exhaustedMarker(
                    `[⚠️ STOPPED — the model sent malformed JSON ${malformedRounds} times in a row ${verdict.why}. ` +
                    `Last failure: ${reason}. Wake it again to continue.] `,
                    response
                ));
            }
            response = await countedSend(malformedCorrectionMsg(reason, malformedRounds, config.maxMalformedRounds), toolDefs);
            continue;
        }

        // CONVERSATION MODE (ALLOW_PLAIN_TEXT=true): personal threads
        // reply directly in natural text / markdown without artificial tool nudges.
        if (config.allowPlainText) {
            const prose = cleanWebchatText(cleanProse(response));
            return finalAnswerFor(prose);
        }

        // Always-tool mode: ANY plain-text reply is a format error, yap or not.
        // Progress reports get a sharper correction: DeepSeek's chat behavior is
        // to pause after tool work and summarize ("I added X, next I will Y") —
        // the generic format message alone doesn't break that habit (2nd-session
        // transcript 08-12: yapped a progress report after write_file AND after
        // "continue").
        if (round < config.maxToolRounds - 1) {
            const yap = looksLikeYap(response);
            console.log(`⚠️ webchat replied without tool JSON (round ${round + 1})${yap ? ' [progress-report yap]' : ''} — sending FORMAT ERROR`);
            // Print what the model actually said. Without this the log records that a reply
            // was rejected and nothing about WHY, which makes "the model is flaky" and "the
            // shape it used is one we do not accept" indistinguishable — the same blind spot
            // that hid the flat-args bug and the raw-newline write_file bug for a whole
            // session each. 400 chars is enough to name the shape.
            console.log(`   raw=[${String(response || '').replace(/\s+/g, ' ').slice(0, 400)}]`);
            onProgress?.({ type: 'rejected', text: yap ? 'plain-text progress report — rejected, demanding the next tool call' : 'plain-text reply — format error sent, demanding fenced tool JSON' });
            response = await countedSend(yap ? YAP_ERROR_MSG : FORMAT_ERROR_MSG, toolDefs);
            continue;
        }
        // Corrections exhausted — surface a SHORT marker. The model's raw
        // reply after context overflow can be a multi-KB echo of its own
        // prompt (08-12: ~30KB dumped into the exhausted marker) — never
        // ship that to the client.
        throw new HarnessIncomplete('no_tool_json', exhaustedMarker('[⚠️ webchat model kept replying without tool-call JSON] ', response));
    }

    // Round budget exhausted without a submit_answer. Cap what the client sees
    // (08-12: the degraded model echoed the entire system prompt here).
    throw new HarnessIncomplete('round_budget', exhaustedMarker('[⚠️ webchat model did not submit a final answer within the round budget] ', response));
}

// The Anthropic SSE sequence a FAILED stream must end with.
//
// Pure and exported so the shape is assertable without a browser: the failure this
// fixes is invisible in a unit test that only checks "did it throw", because the bug
// is the ABSENCE of the terminal events and the dangling content block.
//
// A client that already has an open block only learns the turn is over from
// message_stop; without it Claude Code reports "Server error mid-response" and the
// session cannot continue cleanly.
function streamFailureEvents({ partial = '', openBlock = -1, message = '', errorType = 'api_error' } = {}) {
    const out = [];
    const emit = (event, data) => out.push({ event, data });

    // ★ DO NOT RE-SEND `partial`. It is only a count for the usage line.
    //
    // Every character in it was already streamed as content_block_delta before the
    // failure, in blocks that were already stopped. Emitting it again duplicates the
    // whole answer on the client — which is precisely the REPORTED symptom "tool
    // calls/receipts are rendered twice in the Claude Code terminal". The client has
    // the text; what it is missing is the end of the message.
    //
    // Close a block the loop left open. An unterminated block is the other half of
    // what the client chokes on, so this is not bookkeeping.
    if (typeof openBlock === 'number' && openBlock >= 0) {
        emit('content_block_stop', { type: 'content_block_stop', index: openBlock });
    }

    emit('error', { type: 'error', error: { type: errorType, message: String(message) } });
    emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'error', stop_sequence: null },
        usage: { output_tokens: String(partial).length },
    });
    emit('message_stop', { type: 'message_stop' });
    return out;
}

// How each API shape reports a HarnessIncomplete before any byte was sent. 502:
// the gateway could not get a usable answer from its upstream (the webchat).
function sendIncomplete(res, error, shape) {
    res.set('X-Harness-Outcome', error.outcome);
    if (shape === 'openai') {
        return res.status(502).json({ error: { message: error.message, type: 'harness_incomplete', code: error.outcome } });
    }
    return res.status(502).json({ type: 'error', error: { type: 'harness_incomplete', outcome: error.outcome, message: error.message } });
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
    // PASSTHROUGH_FORMAT: the caller defined the contract, so this gateway has
    // no standing to call its reply malformed. `looksLikeBrokenToolJson` matches
    // any string starting with '{', which is exactly what the oculus engine's
    // {"edits":[...]} reply is — the gateway was shredding a valid answer and
    // returning a 79-byte "malformed tool calls" marker, so every step hopped
    // lanes forever. Pass the caller's answer through untouched.
    if (config.passthroughFormat) return text;
    if (looksLikeBrokenToolJson(text)) {
        throw new HarnessIncomplete('malformed', 'webchat model kept sending malformed tool calls — please retry the request');
    }
    if (!text) throw new HarnessIncomplete('empty', 'webchat model gave no reply');
    return text;
}

// Did this reply LOOK like a tool-call attempt that failed to parse? (a
// "tool": envelope anywhere, or the renderer's json/Copy/Download chrome
// glued to an opening brace.) Such a reply goes back to the model as a
// correction — never to the client as raw text.
function looksLikeBrokenToolJson(text) {
    if (typeof text !== 'string') return false;
    return /"tool"\s*:/.test(text) || /^\s*(?:json|txt|text|python|bash|shell)?\s*(?:Copy\s*)?(?:Download\s*)?\{/.test(text);
}

// Cap client-visible markers at ~1.5KB — after context overflow the model's
// raw reply can be a huge echo of its own prompt (08-12: ~30KB of system-prompt
// text shipped inside the exhausted marker to the 2nd session's client).
function truncateForClient(text) {
    if (typeof text !== 'string' || text.length <= 1500) return text;
    return text.slice(0, 1500) + `\n…(truncated — raw reply was ${text.length} chars)`;
}

// A work tool call arrived with no narration — teach it once per request.
const NARRATION_MSG =
    '### NARRATION REQUIRED\n' +
    'Your tool call was not preceded by a send_message. Before every work tool call you MUST send ' +
    'send_message first: one short 💬 line saying what you are about to do and why (shown to the user ' +
    'verbatim). Reply now with that send_message call, then continue with your work tool call.';

const EMPTY_ANSWER_MSG =
    '### EMPTY ANSWER\n' +
    'Your submit_answer had an empty text field — the user received nothing. Deliver your real final ' +
    'answer now: a fenced submit_answer with the content in the text field. If the task is not finished, ' +
    'keep working with your tools until it is, then submit.';

const PROSE_NUDGE =
    'Your message was delivered to the user. Continue the task: reply with your next fenced tool call ' +
    '(```json ... ```), or a fenced submit_answer if the entire task is done and verified.';

// Malformed tool-JSON attempt (raw triple quotes/newlines in string values,
// unescaped quotes, truncated braces). Correct with the specific rule the
// chat model keeps violating — never leak the raw row text to the client.
// The malformed-JSON stop/retry decision, as PURE DATA.
//
// Exported and pure for the same reason `streamFailureEvents` is: the behaviour under test is
// a SEQUENCE of decisions taken across rounds (correct -> correct -> ... -> pause -> retry ->
// stop), and reproducing that against a live browser and a real model is not possible. As a
// pure function the whole policy is assertable, and the loop below merely performs the
// verdict — so the test cannot keep passing while the shipped policy drifts.
//
// Returns one of:
//   { action: 'correct', reason }        — send a correction naming the reason
//   { action: 'retry', reason, waitMs }  — pause, then correct with a fresh streak
//   { action: 'stop', reason, why }      — give up until something wakes the lane
function malformedAction({ malformedRounds, malformedRetries }, config, reason) {
    if (malformedRounds < config.maxMalformedRounds) {
        return { action: 'correct', reason };
    }
    if (config.malformedRetryEnabled && malformedRetries < config.malformedMaxRetries) {
        // The delay is configured in SECONDS because that is how a human thinks about a
        // backoff. It is converted to ms exactly once, here.
        return { action: 'retry', reason, waitMs: Math.max(0, config.malformedRetryDelaySec) * 1000 };
    }
    const why = config.malformedRetryEnabled
        ? `after ${config.malformedMaxRetries} automatic retr${config.malformedMaxRetries === 1 ? 'y' : 'ies'}`
        : 'automatic retry is disabled';
    return { action: 'stop', reason, why };
}

// WHY a tool-call attempt failed to parse, named concretely.
//
// "malformed tool JSON" alone is not actionable: the model cannot tell a raw newline
// from a missing brace from triple quotes, so it resends the same broken shape until the
// budget runs out. Naming the defect is what lets it fix it on the next attempt, and it is
// also what makes the log diagnosable — a parse failure that does not say what it saw
// cannot be told apart from a reader-side bug.
function describeMalformedJson(text) {
    const s = String(text || '');
    if (!s.trim()) return 'the reply was empty';
    if (!/"tool"\s*:/.test(s)) return 'no "tool" field, so this is not a tool call at all';
    if (/(^|[^"\\])"""|\'\'\'/.test(s)) return 'triple quotes inside a string value';
    let inString = false, escaped = false, depth = 0;
    for (const ch of s) {
        if (inString) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = false; continue; }
            if (ch === '\n') return 'a raw line break inside a string value (it must be escaped as \\n)';
            if (ch === '\r') return 'a raw carriage return inside a string value';
            if (ch === '\t') return 'a raw tab inside a string value (it must be escaped as \\t)';
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    if (inString) return 'a string value that is never closed (a missing closing quote)';
    if (depth > 0) return 'a missing closing brace — the reply was cut off before the JSON ended';
    if (depth < 0) return 'an extra closing brace';
    return 'invalid JSON (check the quoting and the commas)';
}

function malformedCorrectionMsg(reason, streak, limit) {
    return '### MALFORMED JSON DETECTED\n' +
        `Your last reply contained a tool-call attempt that could not be parsed: ${reason}.\n` +
        `This is attempt ${streak} of ${limit} in a row — when the limit is reached the run STOPS ` +
        'and waits to be woken again, so fix the shape now.\n' +
        'Resend it as ONE valid fenced JSON object. Rules: escape " as \\", backslashes as \\\\, ' +
        'line breaks as \\n, tabs as \\t. NEVER use triple quotes (""") inside a JSON string — ' +
        'especially in write_file content. For a multi-line file, prefer the edit_file tool: it ' +
        'takes a small old_string/new_string instead of the entire file as one JSON string.\n' +
        '```json\n{"tool":"<name>","params":{...}}\n```';
}

const FORMAT_ERROR_MSG =
    '### FORMAT ERROR\n' +
    'Your last reply had NO tool call — plain text alone is rejected. Every reply must contain exactly one ' +
    'fenced tool call, optionally preceded by ONE short 💬 line:\n' +
    '```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'The fence is MANDATORY — without it this chat renders your backticks as formatting and corrupts the JSON. ' +
    'If the task is complete, use a fenced {"tool":"submit_answer","params":{"text":"your final answer"}}. ' +
    'If you wrote an implementation as prose, that is NOT the work: re-emit it as write_file tool calls instead.';

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
    '### FORMAT ERROR — no tool call in that reply\n' +
    'Your last message had no tool call. A progress report or summary on its own is rejected every time — ' +
    'your work happens through tools, and it reaches the user as your one 💬 line inside the next reply. ' +
    'The task is not done until every part is done and verified. Respond now with exactly one fenced JSON: ' +
    'your next tool call (```json {"tool":"<name>","params":{...}} ```), or — only if the entire task is ' +
    'complete and verified — submit_answer.';

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
                const result = await runTool(call.toolName, call.args, { threadId: config.webchatUrl || null });
                const p = String(call.args?.path || '');
                if (call.toolName === 'write_file' && /handoff/i.test(p)) handoffPath = p;
                response = await countedSend(
                    formatToolResultView(call, result, 6000, { forModel: true }) + '\n\n' +
                    'The task is: write the handoff document via write_file (if you have not yet) at EXACTLY ' +
                    `${config.handoffFile}, then reply with a fenced submit_answer — one line confirming the path.`,
                    toolDefs
                );
                continue;
            }
            if (looksLikeBrokenToolJson(response) && round < 2) {
                // Name the defect here too — this is the ONE tool call this flow needs,
                // so a generic "malformed" leaves the model guessing at the same shape.
                response = await countedSend(malformedCorrectionMsg(describeMalformedJson(response), 1, config.maxMalformedRounds), toolDefs);
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
    const supervisor = process.env.STACK_SUPERVISOR || path.join(PATHS.workspaceRoot(), 'oculus', 'scripts', 'stack_supervisor.sh');
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
        const child = spawn('bash', ['-c', 'bash "' + supervisor + '" >> /tmp/stack_supervisor.log 2>&1'], {
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
        executableTools: buildExecutableToolDefs().map((t) => t.name),
        responseFormat: {
            allowPlainText: config.allowPlainText,
            noTools: config.noTools,
        },
        contextHandoff: {
            enabled: config.contextHandoffEnabled,
            threshold: config.contextHandoffThreshold,
            handoffFile: config.handoffFile,
        },
        timestamp: new Date().toISOString(),
    });
});

// ── GET /metrics — live numbers for the dashboard ───────────────────────────
// The CLI polls this to render "time since last send", "average latency",
// "waiting for the browser", "cooling down until…" and so on. (Every one of those
// must actually be IN the payload below — this comment described an "average
// latency" the response did not carry, which is worse than not mentioning it.)
// Kept separate from
// /health on purpose: /health is a liveness probe with a status code that other
// tooling depends on (503 when not attached), while /metrics is an observation
// surface that must always answer 200 and never lie about readiness.
app.get('/metrics', (req, res) => {
    const now = Date.now();
    const sinceLastSend = lastSendAt > 0 ? now - lastSendAt : null;

    // How long until the next send is permitted, per the pacing gate. Mirrors the
    // gate in countedSend, including its conditions — reporting a gap that the gate
    // does not actually apply is worse than reporting nothing, because the dashboard
    // is what a user watches while a run looks slow.
    //
    // The random gap is a DeepSeek anti-ban measure and is NOT applied to other
    // webchats (see countedSend). Gemini therefore has NO pacing gap, and the
    // dashboard said "20-80s between sends" for it — a wait that never happens.
    const account = process.env.WEBCHAT_ACCOUNT || String(process.env.PORT || '');
    const pacing = (() => {
        const lo = Math.max(0, Math.min(SEND_GAP_MIN_MS, SEND_GAP_MAX_MS));
        const hi = Math.max(lo, SEND_GAP_MAX_MS);
        const applies = usesDeepSeek();
        return {
            applies,
            // Only meaningful when it applies; 0 otherwise, so a consumer can read
            // min/max unconditionally without inventing a wait.
            min: applies ? lo : 0,
            max: applies ? hi : 0,
            reason: applies ? 'deepseek anti-bot spacing' : 'no pacing on this webchat',
            elapsedSinceLastSend: sinceLastSend,
        };
    })();

    const rateLimit = (() => {
        try {
            const remain = RATE_LIMIT.remainingMs(account);
            return {
                enabled: RATE_LIMIT.enabled(),
                coolingDown: remain > 0,
                cooldownRemainingMs: Math.max(0, remain),
                account,
            };
        } catch (e) {
            return { enabled: false, error: String(e && e.message) };
        }
    })();

    res.status(200).json({
        // identity
        uptimeMs: typeof processStartAt === 'number' ? now - processStartAt : null,
        webchat: config.webchatUrl,
        model: config.modelName || null,
        // liveness (mirrors /health, but as data)
        browserAlive: (() => {
            try { const pg = getPage(); return !!pg && !pg.isClosed(); } catch { return false; }
        })(),
        requestInFlight,
        inFlightMs: requestInFlight && lastSendAt > 0 ? now - lastSendAt : 0,
        // activity
        sendCount,
        lastSendAgoMs: sinceLastSend,
        pacing,
        latency: latencyStats(),
        rateLimit,
        // send bookkeeping
        sendRetriesLeft,
        lastBodyChars: lastReqBodyChars,
        handoffAgoMs: lastHandoffAt > 0 ? now - lastHandoffAt : null,
        jev: jevStats,
        tools: (() => { try { return getToolDefinitions().length; } catch { return 0; } })(),
        timestamp: new Date().toISOString(),
    });
});

app.get('/tools', (req, res) => {
    res.json(getToolDefinitions());
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

// Health probe for the systemd watchdog. A wedged gateway (waiting forever on a
// dead webchat tab) is still an ALIVE process, so Restart=always never fires —
// observed 2026-09-11, five manual restarts in one hour. This reports whether the
// browser session is actually usable, so the watchdog can restart on a wedge.
app.get('/health', (req, res) => {
    // `browser` is module-private to browser.js, so probe the live page instead:
    // getPage() is exported and is null until a tab is attached.
    const alive = (() => {
        try {
            const pg = getPage();
            return !!pg && !pg.isClosed();
        } catch { return false; }
    })();
    // A send outstanding for over 4 minutes is the wedge signature. There is no
    // in-flight flag to read, so the proxy is "a send started and no completion
    // was recorded since" — lastSendAt is refreshed at completion in sendPrompt.
    //
    // Guard the never-sent case: lastSendAt starts at 0, so `Date.now() - 0` is
    // the epoch in ms and the gateway reported `wedged:true` with a nonsense
    // outstandingMs (1.7e12) on a perfectly idle process — which 503s /health and
    // makes the watchdog restart a healthy gateway. Only a timestamp that is
    // actually within this process's lifetime counts as an outstanding send.
    const started = typeof processStartAt === 'number' ? processStartAt : 0;
    // 09-18 BUG: `lastSendAt` is set at send START and NEVER cleared (the comment
    // below claimed sendPrompt refreshes it at completion - it does NOT; grep proves
    // the only write is the start). So `Date.now() - lastSendAt` grew without bound,
    // and three consumers read it as "a send is in flight":
    //   - /health read `wedged:true` + HTTP 503 on a HEALTHY IDLE gateway once the
    //     value passed 3x TIMEOUT (spurious restarts, lying probes);
    //   - /newchat (below) 409-deferred the 5-step context reset forever;
    //   - the engine's _post_if_idle skipped the reset forever.
    // The value cannot be cleared there, because the send GATE uses lastSendAt as a
    // timestamp for spacing. Instead, bound it: the gateway aborts any send at
    // TIMEOUT, so a value older than TIMEOUT + margin is definitionally NOT in flight.
    // 09-22: the bounding above was the best available proxy at the time, but a real
    // flag has existed all along — `requestInFlight` is raised at handleRequest()
    // entry and cleared in its `finally`, so it is authoritative and self-healing.
    // The proxy was wrong in BOTH directions: it reported busy for TIMEOUT+60s after
    // every FINISHED send (the compaction reset was deaf for 31 minutes), and a
    // genuine send that outran TIMEOUT+60s reported idle — exactly the case the
    // guard exists to protect. Read the flag; keep lastSendAt only to age the send.
    const _since = requestInFlight && typeof lastSendAt === 'number' && lastSendAt > started
        ? Date.now() - lastSendAt : 0;
    const busySince = _since;
    // The wedge threshold MUST exceed the request timeout, or the watchdog kills
    // the gateway while a legitimate long send is still running: gemini takes
    // 150-260s per reply and the gemini unit sets TIMEOUT=300000, so a flat 240s
    // threshold guillotined healthy in-flight calls every 2 minutes (observed
    // 2026-09-11 — the client saw RemoteDisconnected mid-request). Derive it from
    // the configured timeout plus a queue margin instead of hardcoding.
    //
    // 2026-09-12 (owner): `timeout + 30s` was still too eager — a slow webchat
    // reply is NOT a wedge, and restarting it mid-cogitation throws away the
    // work in progress. Default is now 3x the timeout, and WEDGE_THRESHOLD_MS
    // overrides it outright. A real wedge (dead tab, never answering) still
    // gets caught, just after the call has had a fair chance to finish.
    const wedgeThresholdMs =
        parseInt(process.env.WEDGE_THRESHOLD_MS) || (config.timeout || 300000) * 3;
    const wedged = busySince > wedgeThresholdMs;
    res.status(alive && !wedged ? 200 : 503).json({
        ok: alive && !wedged,
        browserAlive: alive,
        wedged,
        outstandingMs: busySince,
        wedgeThresholdMs,
    });
});

// ── GET / — what this gateway can do ────────────────────────────────────────
// There was no discovery surface at all: a new user had to read the source to
// learn the endpoint names, and even a running gateway answered "Cannot GET /".
// Machine-readable (Accept: application/json) and human-readable in a browser.
app.get('/', (req, res) => {
    const wantsJson = String(req.headers.accept || '').includes('application/json');
    const info = {
        service: 'webchat-to-api harness',
        mode: config.webchatMode,
        model: config.modelName,
        base_url: `http://${config.host}:${config.port}`,
        openai_compatible: `http://${config.host}:${config.port}/v1`,
        endpoints: {
            'GET  /': 'this document',
            'GET  /health': 'browser + in-flight status (200 healthy, 503 wedged)',
            'GET  /status': 'connected tab, model, tool count',
            'GET  /v1/models': 'model list, OpenAI-shaped',
            'POST /v1/chat/completions': 'chat; the webchat tab is the model',
            'POST /v1/messages': 'Anthropic Messages shape, for Claude Code',
            'POST /connect': 'attach to the browser',
            'POST /newchat': 'open a fresh, EMPTY thread',
            'POST /handoff': 'open a fresh thread AND seed it (body: {content})',
            'POST /__shutdown': 'stop the gateway',
        },
        notes: [
            'The browser opens minimised on purpose. To sign in, run: ./scripts/launch-agent.sh any',
            'Point any coding agent here with: ./scripts/launch-agent.sh <opencode|claude|codex|aider|hermes>',
            'A model sent to /v1/chat/completions must equal the `model` above.',
            'Codex: set model_provider to this base URL and model to "anymodel" or "webchat" (no slash — see /v1/models).',
            `Response format: allowPlainText=${config.allowPlainText} noTools=${config.noTools}`,
        ],
    };
    if (wantsJson) return res.json(info);
    const lines = [
        `webchat-to-api harness — ${info.mode} (${info.model})`,
        '',
        `  base URL   ${info.base_url}`,
        `  OpenAI     ${info.openai_compatible}`,
        '',
        '  endpoints',
        ...Object.entries(info.endpoints).map(([k, v]) => `    ${k.padEnd(26)} ${v}`),
        '',
        '  ' + info.notes.join('\n  '),
        '',
    ];
    res.type('text/plain').send(lines.join('\n'));
});

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
    // 09-22 A3: Codex's orchestration checker rejects slash syntax like
    // "webchat-local/anymodel" (it reads provider/model and knows neither). Codex
    // wants a PLAIN model id paired with a `model_provider` block pointing at this
    // base URL. `anymodel` and `webchat` are the Codex-friendly aliases — send one
    // of them as `model` and it routes to the webchat (isWebchatModel accepts both).
    const codexRows = [
        { id: 'anymodel', display_name: 'Webchat (Codex alias — routes to the tab)' },
        { id: 'webchat', display_name: 'Webchat (Codex alias)' },
    ];
    res.json({
        object: 'list',
        data: [
            ...gatewayRows.map((r) => ({ ...r, object: 'model', owned_by: 'webchat-api' })),
            ...codexRows.map((r) => ({ ...r, object: 'model', owned_by: 'webchat-api' })),
            { id: config.modelName, object: 'model', owned_by: 'webchat-api' },
            // 09-24: each toggle combination is a selectable model — choosing one
            // makes the gateway set the webchat's chips over CDP before it sends.
            ...WEBCHAT_MODELS.allModelIds().map((id) => ({
                id, object: 'model', owned_by: 'webchat-api',
                display_name: WEBCHAT_MODELS.parse(id).label,
            })),
            { id: 'deepseek-v4-flash', object: 'model', owned_by: 'upstream-proxy' },
        ],
    });
});

// ── OpenAI-compatible chat completions ──
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, tools, model, stream } = req.body || {};
        if (!isWebchatModel(req.body)) {
            if (refuseUnlistedUpstreamModel(req.body, res)) return;
            return proxyTo(req, res, UPSTREAM_OPENAI.base, '/chat/completions', req.body, { token: UPSTREAM_OPENAI.token });
        }
        await applyModelSelection(req.body);
        if (stream) console.log('⚠️  stream requested — responding non-streamed');

        // 09-13: if this account is cooling from a "Messages too frequent"
        // throttle, answer 429 immediately with Retry-After instead of sending
        // into the throttle. A caller that retries into it burns its whole round
        // budget on a lane that cannot answer; a fast 429 lets it move on.
        if (RATE_LIMIT.enabled()) {
            const cool = RATE_LIMIT.remainingMs(process.env.WEBCHAT_ACCOUNT || process.env.PORT);
            if (cool > 0) {
                const secs = Math.ceil(cool / 1000);
                console.log(`⏳ rate-limit cooldown: ${secs}s left — answering 429`);
                res.set('Retry-After', String(secs));
                return res.status(429).json({
                    error: {
                        message: `Webchat account throttled ("Messages too frequent"). Retry in ${secs}s.`,
                        type: 'rate_limit_error',
                        code: 'webchat_rate_limited',
                        retry_after_seconds: secs,
                    },
                });
            }
        }

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
        // IGNORE_CLIENT_SYSTEM must apply on THIS path too: opencode and other
        // openai-compatible agent callers ship their whole harness prompt as the
        // system message here, and the Anthropic-path guard did not cover it —
        // measured 118,900 chars of an agent's own rules landing in the tab.
        const clientSystemText =
            typeof systemMessage?.content === 'string'
                ? systemMessage.content
                : Array.isArray(systemMessage?.content)
                  ? systemMessage.content.map((b) => (b?.type === 'text' ? b.text : '')).join('\n')
                  : '';
        const systemText = config.ignoreClientSystem ? config.systemPrompt : clientSystemText;
        if (config.ignoreClientSystem && clientSystemText) {
            console.log(`🚫 dropped the caller's system message (${clientSystemText.length} chars) — IGNORE_CLIENT_SYSTEM is on`);
        }
        const userMessage = [...(messages || [])].reverse().find((m) => m.role === 'user');
        const prompt =
            typeof userMessage?.content === 'string'
                ? userMessage.content
                : JSON.stringify(userMessage?.content ?? '');

        // STREAMING (09-16): an agent caller ASKS for stream:true and its SDK
        // parses the reply as SSE. Answering with a plain JSON body satisfied
        // curl but hung opencode forever — the SDK sat waiting for `data:`
        // frames that never arrived (measured: request logged, zero output,
        // 3-minute timeouts). Emit a real OpenAI-shaped SSE stream when asked
        // for one: role delta, the content, then [DONE].
        const wantsStream = !!(req.body && req.body.stream === true);

        await ensureMcpDiscovered();
        const toolDefs = buildExecutableToolDefs();

        const text = await enqueue(() =>
            handleRequest(systemText, prompt, toolDefs)
        );

        // 09-13: the webchat can answer the throttle notice as its REPLY (a 200
        // with the text). Detect it, start the cooldown, and surface a 429 so the
        // caller knows this was a throttle and not an empty answer.
        if (RATE_LIMIT.enabled() && RATE_LIMIT.isRateLimitText(text)) {
            const { seconds } = RATE_LIMIT.startCooldown(
                process.env.WEBCHAT_ACCOUNT || process.env.PORT,
                config.rateLimitCooldownSeconds,
            );
            console.log(`🛑 webchat rate limit — cooling this account ${seconds}s`);
            res.set('Retry-After', String(seconds));
            return res.status(429).json({
                error: {
                    message: `Webchat account throttled ("Messages too frequent"). Retry in ${seconds}s.`,
                    type: 'rate_limit_error',
                    code: 'webchat_rate_limited',
                    retry_after_seconds: seconds,
                },
            });
        }
        // a real answer clears any stale cooldown
        if (RATE_LIMIT.enabled()) RATE_LIMIT.clearCooldown(process.env.WEBCHAT_ACCOUNT || process.env.PORT);

        if (wantsStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();
            const id = 'chatcmpl_' + Math.random().toString(36).slice(2, 12);
            const chunk = (delta, finish) => ({
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model || config.modelName,
                choices: [{ index: 0, delta, finish_reason: finish ?? null }],
            });
            res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
            // Chunked so a client's stream parser sees progress on a long answer.
            for (let i = 0; i < text.length; i += 512) {
                res.write(`data: ${JSON.stringify(chunk({ content: text.slice(i, i + 512) }))}\n\n`);
            }
            res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }

        res.set('X-Harness-Outcome', 'ok');
        res.json({
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
        });
    } catch (error) {
        if (error instanceof HarnessIncomplete) {
            console.log(`⛔ request incomplete (${error.outcome}) — returned as an API error, not an answer`);
            if (!res.headersSent && !res.writableEnded && !res.destroyed) return sendIncomplete(res, error, 'openai');
            return;
        }
        console.error('❌ Error:', error);
        // 09-13: the throttle does NOT always arrive as reply TEXT. DeepSeek throws
        // it as a stream error ("DeepSeek stream error: Messages too frequent …
        // rate_limit_reached"), which lands HERE as an exception — so the detection
        // above never ran, no cooldown was set, and the account kept being hammered
        // (measured 16 hits in 15 min, every one a 500 that looked like a gateway
        // bug). Detect the throttle on the ERROR path too and cool the account.
        if (RATE_LIMIT.enabled() && RATE_LIMIT.isRateLimitText(error?.message)) {
            const { seconds } = RATE_LIMIT.startCooldown(
                process.env.WEBCHAT_ACCOUNT || process.env.PORT,
                config.rateLimitCooldownSeconds,
            );
            console.log(`🛑 webchat rate limit (stream error) — cooling this account ${seconds}s`);
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                res.set('Retry-After', String(seconds));
                return res.status(429).json({
                    error: {
                        message: `Webchat account throttled ("Messages too frequent"). Retry in ${seconds}s.`,
                        type: 'rate_limit_error',
                        code: 'webchat_rate_limited',
                        retry_after_seconds: seconds,
                    },
                });
            }
            return;
        }
        // 08-13 EVENING: headersSent guard — a crashed-stream attempt here
        // threw ERR_HTTP_HEADERS_SENT and killed the process the same way.
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.status(500).json({ error: { message: error.message, type: 'api_error' } });
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
    // The index of a content block that has been STARTED but not yet STOPPED, or -1.
    // Only `ev` writes it; the catch block needs it to close a block the loop had
    // open when it threw. Tracked here rather than in the catch because the catch
    // cannot see blockIndex, and re-deriving it would be a guess.
    let openBlock = -1;
    // Text produced so far by the loop. The catch streams it so a failure mid-task
    // still shows the user how far it got, instead of an empty turn plus an error.
    let partial = '';
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
            // OmniRoute 3.8.x serves its API under
            // /api/v1/* — the old '/v1/messages' path returned the Next.js
            // an app shell (HTML) rather than JSON.
            return proxyTo(
                req, res, WEBCHAT_ROUTES[routedModel],
                routedModel === 'omniroute' ? '/api/v1/messages' : '/v1/messages',
                targetBody
            );
        }
        if (!isWebchatModel(routedBody)) {
            if (refuseUnlistedUpstreamModel(routedBody, res)) return;
            return proxyTo(req, res, UPSTREAM_ANTHROPIC.base, '/v1/messages', routedBody, { token: UPSTREAM_ANTHROPIC.token });
        }
        await applyModelSelection(routedBody);

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

        // 09-13: harness.config.json → systemPrompt. perMode[mode] > text > ''.
        // '' keeps the harness's own built-in prompt; a configured prompt REPLACES
        // it for callers that send no system message of their own (a caller that
        // does send one keeps it — its contract wins, as before).
        const configuredSystem = config.systemPrompt || '';
        const clientSystem =
            typeof system === 'string'
                ? system
                : Array.isArray(system)
                  ? system.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
                  : '';
        // IGNORE_CLIENT_SYSTEM: the caller is a coding agent (opencode/Claude
        // Code) whose own system prompt is tens of KB of harness rules that do
        // not apply inside the webchat tab — shipping it is pure noise and a
        // competing contract. With this on, ONLY the harness's own prompt is
        // sent; the caller's tools are already ignored (buildExecutableToolDefs).
        const systemText = config.ignoreClientSystem ? configuredSystem : (clientSystem || configuredSystem);

        const userMessage = [...(messages || [])].reverse().find((m) => m.role === 'user');
        const prompt = Array.isArray(userMessage?.content)
            ? userMessage.content
                  .map((b) => (b.type === 'text' ? b.text : `[${b.type} content]`))
                  .join('\n')
            : userMessage?.content || '';

        await ensureMcpDiscovered();
        const toolDefs = buildExecutableToolDefs();

        const modelName = model || config.modelName;

        if (!stream) {
            const text = await enqueue(() => handleRequest(systemText, prompt, toolDefs));
            res.set('X-Harness-Outcome', 'ok');
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
        const ev = (event, data) => {
            // Keep the catch block's two facts in step with what the client has seen:
            // which block is still open, and what text has actually been delivered.
            if (event === 'content_block_start') openBlock = data.index;
            else if (event === 'content_block_stop') openBlock = -1;
            else if (event === 'content_block_delta' && data.delta && typeof data.delta.text === 'string' && data.delta.type === 'text_delta') {
                partial += data.delta.text;
            }
            if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

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

        const text = await enqueue(() => handleRequest(systemText, prompt, toolDefs, onProgress, () => aborted));
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
        // 09-23 REPORTED (Claude Code against this exact endpoint): "the client
        // receives partial tool output followed by an SSE/server error. This leaves
        // Claude Code unable to report results or continue cleanly."
        //
        // The cause is the SHAPE of the error, not the error itself. Anthropic's
        // protocol ends every stream with message_delta + message_stop, and a client
        // that already has an open content block only learns the turn is over from
        // message_stop. Writing `event: error` and calling res.end() leaves the block
        // open with no terminal event, which Claude Code renders as
        // "API Error: Server error mid-response. The response above may be incomplete."
        // — it cannot tell a finished turn from a cut cable, so a clean failure looks
        // like a network fault and the session is left in an unusable state.
        //
        // So: close any open block, then end the stream with the SAME terminal
        // sequence a success uses, carrying the error in the stop_reason. The client
        // gets a valid finished message it can report on.
        //
        // 08-13 EVENING: the 08-12 writableEnded guard missed the SSE path —
        // ev() writes had ALREADY sent headers when handleRequest threw (180s
        // waitForResponse timeout mid run-until-done task) → res.json() threw
        // ERR_HTTP_HEADERS_SENT → whole process crashed → "connection refused"
        // for every client. Guard headersSent too; on the stream, end with an
        // SSE error event instead of a 500.
        const incomplete = error instanceof HarnessIncomplete;
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            if (incomplete) return sendIncomplete(res, error, 'anthropic');
            res.status(500).json({ type: 'error', error: { type: 'api_error', message: error.message } });
        } else if (!res.writableEnded && !res.destroyed) {
            try {
                const message = String(error && error.message ? error.message : error);
                const errorType = incomplete ? 'harness_incomplete' : 'api_error';
                // Written directly: `ev` is a const inside the try block and is NOT in
                // scope here. Calling it threw a ReferenceError that the bare catch
                // below swallowed, so res.end() never ran and EVERY failed stream left
                // the client hanging on an open connection until its own timeout.
                for (const frame of streamFailureEvents({ partial, openBlock, message, errorType })) {
                    res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
                }
                res.end();
            } catch (e) {
                console.warn('⚠️ could not terminate the failed stream:', e.message);
                try { res.end(); } catch { /* socket gone */ }
            }
        }
    }
});

// ── Manual connect / reconnect ──
// Reset the webchat thread: open a FRESH chat in the same tab.
//
// 09-12 (owner sleep shift): gemini's tab accumulates an unbounded conversation,
// and once the thread is long even a 4500-char prompt hangs for ~6 min
// (observed repeatedly: outstandingMs climbing to 300-370s with no reply, the
// engine stalling on it). The engine's context lives in ITS prompt, not in the
// tab, so dropping the tab's history costs nothing and clears the hang.
app.post('/newchat', async (req, res) => {
    try {
        const pg = getPage();
        if (!pg || pg.isClosed()) {
            return res.status(503).json({ error: 'no live webchat page — POST /connect first' });
        }
        // 09-18 RACE-FREE GUARD. openNewChat() NAVIGATES the tab, so a reset landing while
        // a send is in flight destroys that send's page context and the call can never
        // return. The engine's own pre-check (/health, see _post_if_idle in execute.py)
        // races by construction: it can read idle and post a millisecond later, just as a
        // worker starts a send. Measured on oculus-ds-gw2: reconnect + /newchat churn,
        // then a send stuck at outstandingMs 1597892 (26.6 min) with its send count fallen
        // to 7 against 40/42 on its siblings.
        // The gateway knows its own in-flight state with no race, so the check belongs
        // HERE. A deferred reset is housekeeping, not lost work - the engine's counter
        // keeps ticking and the next cycle lands as soon as the send ends.
        const _started = typeof processStartAt === 'number' ? processStartAt : 0;
        // Same bound as /health: a lastSendAt older than TIMEOUT + margin is a
        // finished send, not an in-flight one. Without this the 409 deferred EVERY
        // reset after the first send, which silently disabled the 5-step context
        // clear on all three DS lanes (Bob's design).
        // 09-22: read the authoritative flag, not the lastSendAt proxy. The proxy
        // made this endpoint deaf for TIMEOUT+60s (31 min) after every finished
        // send, which silently disabled the compaction reset the tool-budget plugin
        // drives. A finished send leaves requestInFlight false immediately.
        const _since = requestInFlight && (typeof lastSendAt === 'number' && lastSendAt > _started)
            ? Date.now() - lastSendAt : 0;
        const _busySince = _since;
        if (requestInFlight) {
            console.log(`⏸ /newchat deferred — a send is in flight (outstandingMs=${_busySince})`);
            return res.status(409).json({
                ok: false, deferred: true, outstandingMs: _busySince,
                error: 'a send is in flight — retry when idle',
            });
        }
          await openNewChat();
          console.log('🆕 /newchat — fresh thread opened');
          res.json({ ok: true, message: 'fresh chat opened', page: getPage() ? getPage().url() : null });
      } catch (e) {
          // A reset that did not happen must NOT answer ok:true. openNewChat now
          // verifies the thread is empty and throws when it is not, so the caller
          // learns the truth instead of seeding a task into stale history — which is
          // how a plan job came to run a command that appears in no plan.
          if (e && e.resetFailed) {
              console.log(`⚠️ /newchat could not clear the thread: ${String(e.message).slice(0, 90)}`);
              return res.status(409).json({
                  ok: false,
                  resetFailed: true,
                  remainingRows: e.remainingRows,
                  error: String(e.message),
              });
          }
          console.log('⚠️ /newchat failed:', String(e.message).slice(0, 90));
          res.status(500).json({ error: String(e.message) });
      }
});

// ── POST /handoff {content} — swap to a fresh thread AND seed it ─────────────
// /newchat swaps the thread and leaves it EMPTY. A caller that swaps mid-session
// therefore loses the conversation unless it can seed the new thread in the same
// breath — and openNewChatAndSeed(text) has done exactly that all along for the
// gateway's own context handoff. This exposes it, so an external compactor can
// produce a summary and land it in one atomic call instead of swapping bare and
// hoping its summary arrives before the next send.
//
// Guarded by requestInFlight (the real flag), NOT the lastSendAt proxy: the swap
// NAVIGATES the tab, so a reset landing mid-send destroys that send's page
// context. Reading the true flag means an idle gateway is never refused.
app.post('/handoff', async (req, res) => {
    try {
        if (!getPage()) {
            return res.status(503).json({ error: 'no live webchat page — POST /connect first' });
        }
        if (requestInFlight) {
            return res.status(409).json({
                ok: false, deferred: true,
                error: 'a send is in flight — retry when idle',
            });
        }
        const content = (req.body && (req.body.content || req.body.text)) || '';
        if (!String(content).trim()) {
            return res.status(400).json({ error: 'content is required — this endpoint seeds the new thread' });
        }
        const { url } = await openNewChatAndSeed(String(content));
        console.log(`🆕 /handoff — fresh thread seeded (${String(content).length} chars) at ${url}`);
        res.json({ ok: true, message: 'fresh chat opened and seeded', page: url || null });
    } catch (e) {
        console.log('⚠️ /handoff failed:', String(e.message).slice(0, 90));
        res.status(500).json({ error: String(e.message) });
    }
});

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

    // ── BIND GUARD (harness C9) ─────────────────────────────────────────────
    // This process drives a browser that is LOGGED INTO a real webchat account,
    // so anyone who can reach the port can use that account. Until now that was
    // protected by convention only: HOST defaults to 127.0.0.1, but a single
    // HOST=0.0.0.0 (or an env file edit) exposed the logged-in session with no
    // token required. Refuse to start rather than run open.
    const _host = String(config.host || '').toLowerCase();
    const _isLoopback = _host === '127.0.0.1' || _host === 'localhost' || _host === '::1';
    if (!_isLoopback && !config.apiToken) {
        console.error(
            `\n❌ REFUSING TO START: HOST is "${config.host}" (not loopback) and no API_TOKEN is set.\n` +
            `   This process drives a browser logged into a real webchat account, so binding it\n` +
            `   to a reachable address without a token exposes that account to anyone who can\n` +
            `   reach the port.\n` +
            `   Fix one of:\n` +
            `     • HOST=127.0.0.1                    (keep it local)\n` +
            `     • API_TOKEN=<a-long-random-string>  (require Bearer auth)\n`
        );
        process.exit(1);
    }
    if (!_isLoopback && config.apiToken) {
        console.log(`🔒 Bound to ${config.host} with bearer auth required (API_TOKEN set).`);
    }

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
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        console.log(`\n🔴 ${sig} — shutting down...`);
        // Tell the disconnect guard this is deliberate, so it does not log a
        // crash or try to re-attach while we are tearing down.
        try { markShuttingDown(); } catch { /* older module shape */ }
        // Bounded: closeBrowser() can hang on a STALE CDP connection (Chrome
        // died — puppeteer waits up to protocolTimeout). Never wedge shutdown.
        await Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 5000))]);
        process.exit(0);
    });
}

// Boot only when run directly. Requiring this module (the regression tests in
// tests/) must not bind a port or connect a browser.
if (require.main === module) {
    main();
}

// ──────────────────────────────────────────────────────
// TEST SEAM (09-21)
// Exposed so tests/ can exercise the mutex and the fresh-chat boundary logic
// against the REAL implementation instead of a re-implementation. Loading this
// module as a library does not start the server (see require.main above).
// ──────────────────────────────────────────────────────
module.exports = {
    acquireDeepSeekLock,
    releaseDeepSeekLock,
    countedSend,
    maybeResetThreadAtBoundary,
    DEEPSEEK_LOCK_DIR,
    NEW_CHAT_EVERY_SENDS,
    needsSingleThread,
    __test: {
        HarnessIncomplete,
        // The express app itself, so a test can drive the real HTTP surface
        // (status codes, stop reasons) on an ephemeral port — no browser.
        app,
        streamFailureEvents,
        setRequestInFlight: (v) => { requestInFlight = !!v; },
        getRequestInFlight: () => requestInFlight,
        setSendCount: (n) => { sendCount = Number(n) || 0; },
        getSendCount: () => sendCount,
        // The phantom-completion guard. Exported so the test drives the SHIPPED
        // decision rather than re-implementing its condition — a copy would keep
        // passing after the real one changed.
        markUnverifiedSubmit,
        claimsWorkDone,
        claimsTestsPass,
        TEST_COMMAND_RE,
        UNVERIFIED_MARKER,
        // Malformed-JSON reporting. Exported so the test drives the SHIPPED reason
        // detector and correction text — a re-implementation would keep passing after
        // the real one drifted, which is exactly how the flat-args bug hid.
        describeMalformedJson,
        malformedCorrectionMsg,
        malformedAction,
    },
};
