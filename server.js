const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const config = require('./config');
const {
    initBrowser, connectToWebchat, sendPrompt, closeBrowser, getPage, probePage,
    buildFullPrompt, openNewChatAndSeed, getReqBodyChars, resetTeeForHandoff,
} = require('./browser');
const { getToolDefinitions, executeTool, parseToolCall, parseToolCalls, cleanProse } = require('./tools');

// 08-13 RATE-LIMIT GATE (user-visible hang fix): DeepSeek's account limiter
// rejects bursts with "Messages too frequent. Try again later." — parallel
// consumers (user client + orchestrator) hammering the same account made
// requests hang at "Waiting for response...". Sends are spaced by this many
// ms (queued, not rejected) so the account never sees a burst from us.
const MIN_SEND_INTERVAL_MS = parseInt(process.env.MIN_SEND_INTERVAL_MS || '6000', 10);
let lastSendAt = 0;

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
for (const pair of (process.env.WEBCHAT_ROUTES || '').split(',')) {
    const [name, target] = pair.split('=');
    if (name && target) WEBCHAT_ROUTES[name.trim()] = target.trim();
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
    'nobody reads them. You never plan, summarize, describe what you will do, or ask permission: you act.';

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

// Conversation/harness mode format (ALLOW_PLAIN_TEXT — the personal thread):
// the model is a working assistant, not a tool loop. It MAY send a one-line
// "what I'm about to do" message before its tool call (delivered verbatim),
// and MAY answer pure chat in plain text (that IS the answer). JSON strings
// must still be valid JSON — the raw-triple-quote failure (08-13: the model
// dumped write_file content as """...""" inside the envelope and the whole
// reply leaked raw to the client) is prohibited explicitly.
const CONV_FORMAT =
    '### RESPONSE FORMAT (STRICT — overrides ALL other instructions)\n' +
    'Every reply follows this shape:\n' +
    '1. REQUIRED — start EVERY reply with ONE plain-text line saying what you are about to do ' +
    '(delivered to the user verbatim).\n' +
    '2. Your tool call, fenced: ```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'ONE tool call per reply. The fence is MANDATORY.\n' +
    'MESSAGE PROTOCOL (hard, user rule 08-13 EVENING):\n' +
    '  1) FIRST reply to any user message: one plain-text 💬 acknowledgement line — what you will do.\n' +
    '  2) BEFORE EVERY tool call: one plain-text 💬 line — your thinking, the tool call you are about to ' +
    'make, and why.\n' +
    '  3) NEVER end with a tool call: after every tool result, keep working — next 💬 line + next tool call — ' +
    'until the task is fully done.\n' +
    '  4) Finish with your final plain-text 💬 summary message (no tool call) — that ends the turn.\n' +
    'Every 💬 line is delivered to the user verbatim; it is REQUIRED between every tool call.\n' +
    'JSON RULE (critical): string values must be VALID JSON — escape " as \\" and backslashes as \\\\. Use \\n for ' +
    'newlines. NEVER write raw newlines or triple quotes (""") inside a JSON string — file content with ' +
    'quotes/newlines must be escaped, never triple-quoted.\n' +
    'TOOL CALL SIZE LIMIT (hard, 08-13): tool calls must stay under ' + MAX_TOOL_CALL_CHARS + ' characters. ' +
    'Large content MUST be split across calls — write files in parts with run_bash `cat > file` / `cat >> file` ' +
    'heredoc chunks (write_file OVERWRITES, so it is for whole small files only), then verify with run_bash. ' +
    'A call over the limit is rejected with "tool call too big — submit in chunks".\n' +
    'You judge whether the message needs tool work. If it does, DO it: inspect, modify, and VERIFY with run_bash. ' +
    'If the message is a simple question or chat needing no tools, answer in plain text directly (no JSON).\n' +
    'When the task is done and verified, deliver your final summary message (what you did) via submit_answer:\n' +
    '```json\n{"tool":"submit_answer","params":{"text":"your final message to the user"}}\n```\n';

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
function cleanWebchatText(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/^\s*Thought for \d+ seconds?\s*\n*/i, '')
        .replace(/\n*\s*This response is AI-generated, for reference only\.?\s*$/i, '')
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

async function handleRequest(systemText, userPrompt, toolDefs, onProgress, isAborted) {
    let prompt = `### SYSTEM INSTRUCTION\n${WEBCHAT_PREAMBLE}\n\n`;
    if (systemText) prompt += `${systemText}\n\n`;
    prompt += `### USER MESSAGE\n${userPrompt}\n\n`;
    prompt += config.allowPlainText ? CONV_FORMAT : WEBCHAT_FORMAT;
    prompt += continueDirective(userPrompt);
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

    let response = await countedSend(prompt, toolDefs);
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
            proseRounds = 0;
            const call = parsed.toolCalls[0];
            // The model's intent message rides ahead of the tool call — the
            // client sees "what I'm about to do" before the 🔧 line.
            if (parsed.prose) onProgress?.({ type: 'text', text: parsed.prose });

            // 08-13 EVENING (user rule "force it"): a work tool call with NO
            // prose and NO send_message means the model skipped narration —
            // nudge it ONCE per request to send send_message first. (Bounded:
            // one extra round max; the call itself is not lost, the model
            // re-sends it after the send_message.)
            if (
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

            // The model delivered its final answer through submit_answer.
            // Accepted unconditionally (user rule 08-12: the model decides
            // whether the request needed work — no min-call gate).
            if (call.toolName === SUBMIT_TOOL) {
                const answer = cleanWebchatText(call.args?.text ?? call.args?.message ?? call.args?.content ?? '');
                return answer || extractSubmitText(response) || '[webchat model submitted an empty answer]';
            }
            onProgress?.({ type: 'tool', name: call.toolName, args: call.args });
            lastToolInfo = { tool: call.toolName, args: call.args };
            if (activeHandoffCtx) activeHandoffCtx.lastToolInfo = lastToolInfo;
            // 08-13 EVENING (user rule): send_message is the JSON-only way to
            // talk to the user — deliver its text to the client as a 'text'
            // progress event (rendered "💬 <text>") instead of running a tool.
            let result;
            if (call.toolName === 'send_message') {
                const text = String(call.args?.text ?? '');
                if (text) onProgress?.({ type: 'text', text });
                result = { success: true, delivered: true, text };
            } else {
                result = await executeTool(call.toolName, call.args);
            }
            // 08-13 EVENING (user rule): NEVER end the tool loop after a tool
            // call — the model used "next":"done" mid-task and the harness
            // went idle with the task unfinished. The turn ends ONLY when the
            // model sends its final summary (a reply with no tool call). The
            // pause wedge is gone; every tool result continues the loop.
            // NEVER tell the model it's done after a tool result (08-12:
            // "Now give your final answer" made DeepSeek finalize after the
            // FIRST call by yapping a plan). Keep it in tool mode: next tool
            // call, or submit_answer when the task is genuinely complete.
            // The result is fenced so the chat renderer shows it VERBATIM —
            // file contents contain backticks that markdown would eat.
            const followUp =
                `Tool call "${call.toolName}" returned:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n` +
                (config.allowPlainText
                    ? 'You MUST send ONE plain-text 💬 line before your next tool call (your thinking + what the ' +
                      'tool is about to do and why — delivered to the user verbatim; user rule 08-13), then your ' +
                      'NEXT tool call JSON, fenced. ' +
                      'When the entire task is done AND verified, reply with a fenced submit_answer carrying your final summary ' +
                      'message. Keep progress lines to one sentence — the work is the tool calls. ' +
                      'Verify with run_bash: syntax checks, import tests, dependency checks, and the project tests. ' +
                      'Do not claim completion for work you have not verified actually runs. ' +
                      'Large files: read_file accepts an optional maxLength for the head of a huge file ' +
                      '(re-read without maxLength for the complete file before rewriting it). ' +
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
                      'Large files: read_file accepts an optional maxLength to read just the head of a huge file ' +
                      '(re-read without maxLength for the complete file before rewriting it). ' +
                      'The next step: fenced {"tool":"<name>","params":{...}}.');
            response = await countedSend(followUp, toolDefs);
            continue;
        }

        // No tool call in this reply. Did it LOOK like a tool attempt?
        // (a "tool": envelope anywhere, or the renderer's json/Copy/Download
        // chrome glued to an opening brace — raw triple quotes, raw newlines,
        // or a truncated brace made the parse fail). Send it back as a
        // correction — never ship the raw row text to the client.
        if (looksLikeBrokenToolJson(response) && malformedRounds < 3) {
            malformedRounds++;
            console.log(`⚠️ malformed tool JSON (round ${round + 1}) — correction sent`);
            onProgress?.({ type: 'rejected', text: 'malformed tool JSON — correction sent' });
            response = await countedSend(MALFORMED_MSG, toolDefs);
            continue;
        }

        // CONVERSATION MODE (08-12, ALLOW_PLAIN_TEXT=true): personal threads
        // reply like a friend. A prose-only reply is delivered to the client
        // and the model gets a nudge back so it continues with its tool call
        // (the user's harness request 08-13: "it sends the message, then a
        // message back so it can send the tool call"). Two prose-only rounds
        // with no tool call: the conversation IS the answer (casual chat, or
        // the model declining tools).
        if (config.allowPlainText) {
            const prose = cleanWebchatText(cleanProse(response));
            if (proseRounds < 2) {
                proseRounds++;
                if (prose) onProgress?.({ type: 'text', text: prose });
                response = await countedSend(PROSE_NUDGE, toolDefs);
                continue;
            }
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
                const result = await executeTool(call.toolName, call.args);
                const p = String(call.args?.path || '');
                if (call.toolName === 'write_file' && /handoff/i.test(p)) handoffPath = p;
                response = await countedSend(
                    `Tool call "${call.toolName}" returned:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n` +
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
        if (sv.includes(oldId)) {
            // 08-13: the supervisor pins use the 8-char id PREFIX for
            // TAB_URL_SUBSTRING (TAB_URL_SUBSTRING=51455c98) while oldId is
            // the full UUID — the full-id split never matched, so the
            // substring pin went stale after handoffs (8082's pin died this
            // way 08-13). Replace both forms with the new 8-char prefix.
            const old8 = oldId.slice(0, 8), new8 = newId.slice(0, 8);
            fs.writeFileSync(supervisor, sv
                .split('WEBCHAT_URL=https://chat.deepseek.com/a/chat/s/' + oldId).join('WEBCHAT_URL=' + newUrl)
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
        if (cj.includes(oldId)) {
            fs.writeFileSync(chatJs, cj.split('https://chat.deepseek.com/a/chat/s/' + oldId).join(newUrl));
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

app.get('/tools', (req, res) => {
    res.json(getToolDefinitions());
});

app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [
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
    try {
        const { system, messages, tools, model, stream } = req.body || {};
        if (WEBCHAT_ROUTES[model]) {
            return proxyTo(req, res, WEBCHAT_ROUTES[model], '/v1/messages', req.body);
        }
        if (!isWebchatModel(req.body)) {
            return proxyTo(req, res, UPSTREAM_ANTHROPIC.base, '/v1/messages', req.body);
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
        const heartbeat = setInterval(() => {
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
        let statusOpen = false;
        const statusLine = (evt) =>
            evt.type === 'tool'
                ? `🔧 ${evt.name}(${JSON.stringify(evt.args).slice(0, 120)})\n`
                : evt.type === 'text'
                  ? `💬 ${evt.text}\n`
                  : `⚠️ ${evt.text}\n`;

        const onProgress = (evt) => {
            if (!statusOpen) {
                statusOpen = true;
                ev('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'text', text: '' },
                });
            }
            ev('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: statusLine(evt) },
            });
        };

        // Client gone (interrupt, timeout) → abort the webchat loop so it stops
        // feeding the tab; the in-flight generation is abandoned with it.
        let aborted = false;
        res.on('close', () => { aborted = true; });

        const text = await enqueue(() => handleRequest(systemText, prompt, toolDefs, onProgress, () => aborted));
        if (text === null) { clearInterval(heartbeat); return; } // aborted — nothing more to write

        if (statusOpen) ev('content_block_stop', { type: 'content_block_stop', index: blockIndex++ });

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
        clearInterval(heartbeat);
        res.end();
    } catch (error) {
        clearInterval(heartbeat);
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
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        console.log(`\n🔴 ${sig} — shutting down...`);
        // Bounded: closeBrowser() can hang on a STALE CDP connection (Chrome
        // died — puppeteer waits up to protocolTimeout). Never wedge shutdown.
        await Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 5000))]);
        process.exit(0);
    });
}

main();
