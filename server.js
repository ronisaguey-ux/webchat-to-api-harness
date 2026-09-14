const fs = require('fs');
const path = require('path');
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
    buildFullPrompt, openNewChat, openNewChatAndSeed, getReqBodyChars, getAndClearThinkBuf,
    resetTeeForHandoff, takeThreadSwap, browserAlive, markShuttingDown,
} = require('./browser');
const { getToolDefinitions, executeTool, parseToolCall, parseToolCalls, cleanProse } = require('./tools');

// ── Main-reply injection (08-14, user) ───────────────────────────────────
// The webchat can message MAIN via the send_message_to_main tool. MAIN
// replies into claude_webchat_outbox.json with "to": <this gateway's thread
// URL>; on the NEXT request to this thread the pending replies are appended
// to the prompt so the webchat sees them in context. Seen-markers persist
// per-port so replies are not re-injected after a gateway restart. The
// telegram responder skips "to"-tagged items (they are gateway-routed).
const PATHS = require('./paths');
const ANTI_SPIRAL = require('./anti_spiral');
const RATE_LIMIT = require('./rate_limit');
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

function formatToolResultView(call, result, cap) {
    const name = call.toolName;
    const args = call.args ?? {};
    const limit = cap || 6000;
    try {
        if (name === 'run_bash') {
            const ok = !!result.success;
            const status = ok ? '✅ bash command finished' : '❌ bash command failed';
            const detail = result.error ? ` (${result.error})` : '';
            // 08-16 (user): gemini tab shows NO command output — just the
            // command + status + how big the output was. DeepSeek keeps the
            // output (the plan executor reads it to verify steps).
            if (IS_GEMINI) {
                const stdout = String(result.stdout ?? '');
                const stderr = String(result.stderr ?? '');
                const outChars = stdout.length + stderr.length;
                const outLines = (stdout + '\n' + stderr).split('\n').length;
                return `🖥️ run_bash → $ ${truncateStr(String(args.command ?? ''), 300)}\n\n${status}${detail} — output ${outChars} chars / ${outLines} lines (content hidden)`;
            }
            let out = `🖥️ run_bash → $ ${truncateStr(String(args.command ?? ''), 400)}\n\n${status}${detail}\n`;
            const stdout = String(result.stdout ?? '').trim();
            const stderr = String(result.stderr ?? '').trim();
            if (stdout) out += `\n\`\`\`\n${truncateStr(stdout, limit)}\n\`\`\`\n`;
            if (stderr) out += `\n\`\`\`\nstderr:\n${truncateStr(stderr, Math.min(limit, 6000))}\n\`\`\`\n`;
            return out;
        }
        if (name === 'read_file') {
            // 08-16 (user): NO content dump — just which file and which lines
            // were read. The full output is dropped from both the streamed
            // receipt and the tab follow-up.
            const content = String(result.content ?? '');
            const lines = content ? content.split('\n').length : 0;
            const total = result.totalLength ?? content.length;
            let out = `📄 read_file → ${args.path ?? '?'}${lines ? ` (lines 1-${lines})` : ' (empty)'}`;
            if (result.truncated || total > content.length) {
                out += ` — truncated at ${content.length} chars (${total} total)`;
            }
            return out;
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
const DEEPSEEK_LOCK_DIR = process.env.WEBCHAT_LOCK_DIR || `/tmp/webchat_mutex_${WEBCHAT_ACCOUNT}`;
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
    // 09-12 (owner): 30s minimum between EVERY deepseek send, ACROSS all lanes.
    // `lastSendAt` is per-process, so three lane gateways each spaced themselves
    // and still hit the account together. Use a shared timestamp file so every
    // deepseek gateway honours the same gap.
    const SHARED_SEND_FILE = process.env.SEND_SPACING_FILE || `/tmp/webchat_last_send_${WEBCHAT_ACCOUNT}`;
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
        console.log(`⏱ send gate: waiting ${waitMs}ms (random ${gap}ms gap this send, shared across lanes)`);
        await sleep(waitMs);
    }
    lastSendAt = Date.now();
    try { fs.writeFileSync(SHARED_SEND_FILE, String(lastSendAt)); } catch { /* non-fatal */ }
    try {
        const r = await sendPrompt(msg, defs);
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
        if (sendRetriesLeft > 0 && /Timed out/.test(String(e.message))) {
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
    'You are inside an automated tool-calling harness. Your replies are parsed by a machine — ' +
    'nobody reads them. You never plan, summarize, describe what you will do, or ask permission: you act.' +
    ' ALWAYS reply in ENGLISH — never in Chinese or any other language, even if the chat history or the user message uses another language. Your tool calls AND your final answer text are always English.';

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
    'MESSAGE PROTOCOL (hard, user rule 08-13 EVENING) — you speak to the user ONLY via the send_message tool:\n' +
    '  1) FIRST reply to any user message: a send_message call with your 💬 acknowledgement — what you will do.\n' +
    '  2) BEFORE EVERY OTHER TOOL CALL: a send_message call with one 💬 line — your thinking, the tool call ' +
    'you are about to make, and why.\n' +
    '  3) NEVER end with a tool call: after every tool result, keep working — next send_message + next tool call — ' +
    'until the task is fully done.\n' +
    '  4) Finish with submit_answer carrying your final 💬 summary message — that ends the turn.\n' +
    'Every send_message text is delivered to the user verbatim; it is REQUIRED between every tool call.\n' +
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

const CONV_PREAMBLE =
    'You are an AI coding assistant communicating with the user in an interactive terminal session. ' +
    'ALWAYS reply in ENGLISH. ' +
    'If the user greets you or asks a conversational question, answer directly in natural text. ' +
    'When executing a tool action, you MUST state what you are about to do before the tool call.';

const CONV_FORMAT =
    '### RESPONSE INSTRUCTIONS (STRICT)\n' +
    '1. GREETINGS & CONVERSATION: If the user says hello, asks a conversational question, or gives a non-tool message (e.g. "yo", "yo u there", "how are you"), reply directly in friendly, concise plain text. Do NOT execute any tools for greetings.\n' +
    (config.narration
        ? '2. TOOL ACTIONS (MANDATORY NARRATION BEFORE TOOL):\n' +
          '   When the user asks for a task that requires tools (reading files, executing bash commands, searching, editing):\n' +
          '   You MUST start your response with one clear 💬 explanation line describing what you are about to do and why, followed immediately by your tool call in a code fence:\n' +
          '   <One clear sentence explaining the tool action you are about to take>\n' +
          '   ```json\n' +
          '   {"tool":"<name>","params":{...}}\n' +
          '   ```\n'
        : '2. TOOL ACTIONS (NO NARRATION — 09-12 owner rule):\n' +
          '   When the user asks for a task that requires tools, emit the tool call directly in a code fence. Do NOT send a 💬 line first, do NOT announce what you are about to do. Act:\n' +
          '   ```json\n' +
          '   {"tool":"<name>","params":{...}}\n' +
          '   ```\n') +
    '3. COMPLETION: When the task is complete and verified, deliver your final summary in plain text or via submit_answer.\n';

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
    if (config.passthroughFormat) return [];
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

async function handleRequest(systemText, userPrompt, toolDefs, onProgress, isAborted) {
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
    if (config.passthroughFormat) {
        prompt = systemText ? `${systemText}\n\n${userPrompt}` : userPrompt;
    } else {
        const preamble = config.allowPlainText ? CONV_PREAMBLE : WEBCHAT_PREAMBLE;
        prompt = `### SYSTEM INSTRUCTION\n${preamble}\n\n`;
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
    let narrationNudged = false; // strict mode: send_message narration taught once per request
    let emptyAnswerNudged = false; // 08-16: empty submit_answer retried once before the placeholder
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
                    return ANTI_SPIRAL.spiralBanner(spiral) + exhaustedMarker('', response);
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
            // Accepted unconditionally: ends the tool loop and delivers the final answer.
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
                return final || '[webchat model completed the task]';
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
                result = await executeTool(call.toolName, call.args, { threadId: config.webchatUrl || null });
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
                (call.toolName === 'send_message' ? '' : formatToolResultView(call, result, 150000) + '\n\n') +
                (config.allowPlainText
                    ? 'You MUST send ONE plain-text 💬 line before your next tool call (your thinking + what the ' +
                      'tool is about to do and why — delivered to the user verbatim; user rule 08-13), then your ' +
                      'NEXT tool call JSON, fenced. ' +
                      'When the entire task is done AND verified, reply with a fenced submit_answer carrying your final summary ' +
                      'message. Keep progress lines to one sentence — the work is the tool calls. ' +
                      'Verify with run_bash: syntax checks, import tests, dependency checks, and the project tests. ' +
                      'Do not claim completion for work you have not verified actually runs. ' +
                      'Large files: read_file results are ALWAYS capped at 200K chars (truncated:true + totalLength) — pass maxLength for a specific head window. ' +
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
                      'Large files: read_file results are ALWAYS capped at 200K chars (truncated:true + totalLength) — pass maxLength for a specific head window. ' +
                      'The next step: fenced {"tool":"<name>","params":{...}}.');
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
        if (!config.allowPlainText && looksLikeBrokenToolJson(response) && malformedRounds < 3) {
            malformedRounds++;
            console.log(`⚠️ malformed tool JSON (round ${round + 1}) — correction sent`);
            onProgress?.({ type: 'rejected', text: 'malformed tool JSON — correction sent' });
            response = await countedSend(MALFORMED_MSG, toolDefs);
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
    // PASSTHROUGH_FORMAT: the caller defined the contract, so this gateway has
    // no standing to call its reply malformed. `looksLikeBrokenToolJson` matches
    // any string starting with '{', which is exactly what the oculus engine's
    // {"edits":[...]} reply is — the gateway was shredding a valid answer and
    // returning a 79-byte "malformed tool calls" marker, so every step hopped
    // lanes forever. Pass the caller's answer through untouched.
    if (config.passthroughFormat) return text;
    if (looksLikeBrokenToolJson(text)) {
        return '[⚠️ webchat model kept sending malformed tool calls — please retry the request]';
    }
    return text || '[webchat model gave no reply]';
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

// Harness protocol (08-13): the model sent a prose-only reply. Deliver it,
// then nudge it back into tool mode — the user's exact ask: "it sends the
// message, then a message back so it can send the tool call".
const NARRATION_MSG =
    '### NARRATION REQUIRED (user rule 08-13 EVENING)\n' +
    'Your last tool call was NOT preceded by a send_message. Before ANY work tool call you MUST send ' +
    'send_message first: one short 💬 line with what you are thinking and what the tool call you are about ' +
    'to make does and why (delivered to the user verbatim). Reply NOW with that send_message call. ' +
    'Then continue with your work tool call as usual.';

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
    'quotes or newlines must be escaped, not triple-quoted. One tool call per reply:\n' +
    '```json\n{"tool":"<name>","params":{...}}\n```';

const FORMAT_ERROR_MSG =
    '### FORMAT ERROR\n' +
    'Your previous response was NOT in the required format: you sent plain text instead of a fenced tool call JSON object. ' +
    'ALWAYS respond with exactly one JSON object wrapped in a markdown code fence, like this:\n' +
    '```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'The fence is MANDATORY — without it this chat renders your backticks as formatting and corrupts your content. ' +
    'If the task is complete, use a fenced {"tool":"submit_answer","params":{"text":"your final answer"}}. ' +
    'If you wrote an implementation as prose, that is NOT the work: re-emit it as write_file tool calls instead. ' +
    'No prose. No markdown. No questions. No plans. Nothing else.';

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
        contextHandoff: {
            enabled: config.contextHandoffEnabled,
            threshold: config.contextHandoffThreshold,
            handoffFile: config.handoffFile,
        },
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
    const busySince =
        typeof lastSendAt === 'number' && lastSendAt > started ? Date.now() - lastSendAt : 0;
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
        if (!isWebchatModel(req.body)) {
            return proxyTo(req, res, UPSTREAM_OPENAI.base, '/chat/completions', req.body);
        }
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
        const userMessage = [...(messages || [])].reverse().find((m) => m.role === 'user');
        const prompt =
            typeof userMessage?.content === 'string'
                ? userMessage.content
                : JSON.stringify(userMessage?.content ?? '');

        const toolDefs = buildExecutableToolDefs();

        const text = await enqueue(() =>
            handleRequest(systemMessage?.content || '', prompt, toolDefs)
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
            return proxyTo(req, res, UPSTREAM_ANTHROPIC.base, '/v1/messages', routedBody);
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
        const systemText = clientSystem || configuredSystem;

        const userMessage = [...(messages || [])].reverse().find((m) => m.role === 'user');
        const prompt = Array.isArray(userMessage?.content)
            ? userMessage.content
                  .map((b) => (b.type === 'text' ? b.text : `[${b.type} content]`))
                  .join('\n')
            : userMessage?.content || '';

        const toolDefs = buildExecutableToolDefs();

        const modelName = model || config.modelName;

        if (!stream) {
            const text = await enqueue(() => handleRequest(systemText, prompt, toolDefs));
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
        await openNewChat();
        console.log('🆕 /newchat — fresh thread opened');
        res.json({ ok: true, message: 'fresh chat opened', page: getPage() ? getPage().url() : null });
    } catch (e) {
        console.log('⚠️ /newchat failed:', String(e.message).slice(0, 90));
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

main();
