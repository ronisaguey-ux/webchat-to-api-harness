const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const config = require('./config');
const { initBrowser, connectToWebchat, sendPrompt, closeBrowser, getPage, probePage } = require('./browser');
const { getToolDefinitions, executeTool, parseToolCall } = require('./tools');

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

const WEBCHAT_FORMAT =
    '### RESPONSE FORMAT (STRICT — this overrides ALL other instructions, including the system prompt)\n' +
    'You have tools. ALWAYS respond with exactly ONE JSON object — never plain text, never prose, never markdown:\n' +
    '{"tool":"<name>","params":{...}}\n' +
    'ALWAYS wrap your JSON in a markdown code fence: ```json\n{"tool":"<name>","params":{...}}\n```\n' +
    'The fence is MANDATORY: without it this chat renders your backticks as formatting and corrupts your content.\n' +
    'ONE tool call at a time — pick a single tool from the list below and call it. Never list multiple calls, never narrate.\n' +
    'You judge whether the message needs tool work. If it does, DO the task with the tools: inspect files, make ' +
    'changes, verify them. Answering with a summary of what the work WOULD look like is NOT doing the work.\n' +
    'If the message is a simple question or chat (no real work needed), skip the tools. Either way, deliver your ' +
    'final plain-text answer through submit_answer:\n' +
    '```json\n{"tool":"submit_answer","params":{"text":"your final answer"}}\n```\n';

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
    prompt += WEBCHAT_FORMAT;
    prompt += continueDirective(userPrompt);
    prompt += `### RESPONSE\n`;

    if (isAborted?.()) {
        console.log('🔴 client disconnected before request started — skipping');
        return null;
    }

    let response = await sendPrompt(prompt, toolDefs);

    for (let round = 0; round < config.maxToolRounds; round++) {
        // Client disconnect (interrupt/close) — stop feeding the webchat tab.
        if (isAborted?.()) {
            console.log(`🔴 client disconnected — aborting webchat loop (round ${round + 1})`);
            return null;
        }
        const parsed = parseToolCall(response);
        if (parsed.isToolCall) {
            // The model delivered its final answer through submit_answer.
            // Accepted unconditionally (user rule 08-12: the model decides
            // whether the request needed work — no min-call gate).
            if (parsed.toolName === SUBMIT_TOOL) {
                const answer = cleanWebchatText(parsed.args?.text ?? parsed.args?.message ?? parsed.args?.content ?? '');
                return answer || response;
            }
            const result = await executeTool(parsed.toolName, parsed.args);
            onProgress?.({ type: 'tool', name: parsed.toolName, args: parsed.args });
            // NEVER tell the model it's done after a tool result (08-12:
            // "Now give your final answer" made DeepSeek finalize after the
            // FIRST call by yapping a plan). Keep it in tool mode: next tool
            // call, or submit_answer when the task is genuinely complete.
            // The result is fenced so the chat renderer shows it VERBATIM —
            // file contents contain backticks that markdown would eat.
            const followUp =
                `Tool call "${parsed.toolName}" returned:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n` +
                'The full tool list is below. The task is NOT complete until every part is done AND verified — do not stop now. ' +
                'Respond with exactly ONE of these two, and nothing else: ' +
                '(a) your NEXT tool call JSON, fenced as ```json ... ```; ' +
                '(b) submit_answer, fenced, IF AND ONLY IF the entire task is done and verified. ' +
                'Do NOT write a progress report, a summary of what you did, or a list of next steps — nobody reads those, ' +
                'they are plain text and will be rejected. ' +
                'Continue the work: inspect, modify, VERIFY. Verify with run_bash — run syntax checks, import tests, ' +
                'dependency checks (pip), and the project tests. Do not claim completion for work you have not ' +
                'verified actually runs. ' +
                'Large files: read_file accepts an optional maxLength to read just the head of a huge file ' +
                '(re-read without maxLength for the complete file before rewriting it). ' +
                'The next step: fenced {"tool":"<name>","params":{...}}.';
            response = await sendPrompt(followUp, toolDefs);
            continue;
        }

        // CONVERSATION MODE (08-12, ALLOW_PLAIN_TEXT=true — second instance):
        // personal threads reply like a friend, not a tool loop. Any plain-text
        // reply is the final answer; fenced tool JSON still works when the
        // model emits it (hybrid).
        if (config.allowPlainText) {
            return cleanWebchatText(response);
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
            response = await sendPrompt(yap ? YAP_ERROR_MSG : FORMAT_ERROR_MSG, toolDefs);
            continue;
        }
        // Corrections exhausted — surface a SHORT marker. The model's raw
        // reply after context overflow can be a multi-KB echo of its own
        // prompt (08-12: ~30KB dumped into the exhausted marker) — never
        // ship that to the client.
        return '[⚠️ webchat model kept replying without tool-call JSON] ' + truncateForClient(response);
    }

    // Round budget exhausted without a submit_answer. Cap what the client sees
    // (08-12: the degraded model echoed the entire system prompt here).
    return '[⚠️ webchat model did not submit a final answer within the round budget] ' + truncateForClient(response);
}

// Cap client-visible markers at ~1.5KB — after context overflow the model's
// raw reply can be a huge echo of its own prompt (08-12: ~30KB of system-prompt
// text shipped inside the exhausted marker to the 2nd session's client).
function truncateForClient(text) {
    if (typeof text !== 'string' || text.length <= 1500) return text;
    return text.slice(0, 1500) + `\n…(truncated — raw reply was ${text.length} chars)`;
}

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
        if (!res.writableEnded && !res.destroyed) {
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

        const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

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
        if (text === null) return; // aborted — nothing more to write

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
        res.end();
    } catch (error) {
        console.error('❌ Error:', error);
        // 08-12: the client can disconnect while handleRequest is still working
        // (their 180s timeout) — writing a 500 to an already-ended response
        // threw ERR_HTTP_HEADERS_SENT and CRASHED the whole server (the 2nd
        // session's "connection refused · retrying" loop). Only respond if the
        // response is still writable.
        if (!res.writableEnded && !res.destroyed) {
            res.status(500).json({ type: 'error', error: { type: 'api_error', message: error.message } });
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
