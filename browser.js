const fs = require('fs');
const puppeteer = require('puppeteer');
const config = require('./config');

let browser = null;
let page = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stale CDP connection (Chrome died, object still says "connected") passes
// every isConnected()-style check yet fails on real work. Probe the page for
// real: a fast evaluate. Bounded to 3s so a half-open socket can't stall.
async function probePage() {
    if (!page || page.isClosed()) return false;
    try {
        await Promise.race([
            page.evaluate(() => 1),
            new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 3000)),
        ]);
        return true;
    } catch {
        return false;
    }
}

// ──────────────────────────────────────────────────────
// 1. INIT
//    Normal mode: launch our own browser.
//    CDP mode (chat.js -> cdpWsUrl): attach to the browser the
//    user already has open and drive their real tab.
// ──────────────────────────────────────────────────────
async function initBrowser({ reconnect = false } = {}) {
    if (reconnect && browser) {
        // A long-lived CDP session can go stale (evaluates hang while fresh
        // sessions work). Detach and attach again — cheap (~50ms).
        try { await browser.disconnect(); } catch {}
        browser = null;
        page = null;
        console.log('🔌 Reconnecting CDP session (stale session refresh).');
    }
    if (browser && browser.isConnected()) {
        console.log('🟢 Browser already connected.');
        return;
    }

    if (config.cdpWsUrl) {
        let wsUrl = config.cdpWsUrl;
        // The ws browser id changes on EVERY Chrome relaunch (memory rule).
        // Resolve the CURRENT id from the CDP HTTP endpoint so a Chrome
        // restart — manual or supervisor-respawned — never strands the
        // server on a dead id. Falls back to the static value if the
        // lookup fails (Chrome down → attach will fail with a clear error).
        try {
            const m = config.cdpWsUrl.match(/^ws:\/\/([^/]+)\//);
            if (m) {
                const r = await fetch(`http://${m[1]}/json/version`, { signal: AbortSignal.timeout(3000) });
                const j = await r.json();
                if (j.webSocketDebuggerUrl) {
                    wsUrl = j.webSocketDebuggerUrl;
                    if (wsUrl !== config.cdpWsUrl) {
                        console.log(`🔄 ws id changed: ${config.cdpWsUrl.split('/').pop()} → ${wsUrl.split('/').pop()}`);
                    }
                }
            }
        } catch (e) {
            console.log(`⚠️  CDP /json/version lookup failed (${e.message}) — using static cdpWsUrl`);
        }
        console.log(`🚀 Attaching to existing browser: ${wsUrl}`);
        browser = await puppeteer.connect({
            browserWSEndpoint: wsUrl,
            defaultViewport: null, // don't resize their window
            protocolTimeout: 120000, // tab can cogitate for minutes before answering
        });
        console.log('✅ Attached to existing browser.');
        return;
    }

    console.log('🚀 Launching browser...');
    browser = await puppeteer.launch({
        headless: config.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 1280, height: 800 },
    });
    page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    console.log('✅ Browser ready.');
}

// ──────────────────────────────────────────────────────
// 2. SESSION PERSISTENCE (cookies)
// ──────────────────────────────────────────────────────
function loadCookies() {
    try {
        const cookies = JSON.parse(fs.readFileSync(config.cookieFile, 'utf-8'));
        return Array.isArray(cookies) ? cookies : [];
    } catch {
        return [];
    }
}

async function saveCookies() {
    try {
        if (!page) return;
        const cookies = await page.cookies();
        fs.writeFileSync(config.cookieFile, JSON.stringify(cookies, null, 2));
    } catch (e) {
        console.warn('⚠️  Cookie save failed:', e.message);
    }
}

// ──────────────────────────────────────────────────────
// 3. CONNECT TO CHAT SESSION
//    Instead of blocking on stdin (the guide's approach, which
//    breaks in server contexts), poll for the chat input box —
//    its presence means the session is logged in.
//    In CDP mode, reuse the user's already-open tab matching
//    the configured URL — no cookie dance at all.
// ──────────────────────────────────────────────────────
async function connectToWebchat(webchatUrl) {
    if (!page) await initBrowser();

    if (config.cdpWsUrl) {
        const pages = await browser.pages();
        page =
            pages.find((p) => p.url().startsWith(new URL(webchatUrl).origin)) ||
            pages.find(
                (p) =>
                    p.url() !== 'about:blank' &&
                    !p.url().startsWith('chrome://') &&
                    !p.url().startsWith('devtools://')
            );
        if (!page) {
            page = await browser.newPage();
            await page.goto(webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        console.log(`🟢 Reusing tab: ${page.url()}`);
        await waitForChatInput(page);
        return page;
    }

    const cookies = loadCookies();
    if (cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`🍪 Loaded ${cookies.length} cookies.`);
    }

    if (!page.url() || page.url() === 'about:blank') {
        console.log(`🌐 Opening webchat: ${webchatUrl}`);
        await page.goto(webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
        console.log(`🟢 Already on page: ${page.url()}`);
    }

    await waitForChatInput(page);
    await saveCookies();
    return page;
}

// Login gate: the chat input's presence means the session is logged in
async function waitForChatInput() {
    const deadline = Date.now() + config.loginWaitMs;
    while (Date.now() < deadline) {
        const el = await firstMatch(config.selectors.input);
        if (el) {
            console.log('✅ Chat input found — logged in.');
            return;
        }
        console.log('🟡 Waiting for login — log into the browser window if prompted...');
        await sleep(3000);
    }
    throw new Error(
        `Login wait timed out after ${config.loginWaitMs / 1000}s — no chat input found. ` +
        'Log in manually, then POST /connect.'
    );
}

// ──────────────────────────────────────────────────────
// 4. SEND PROMPT + GET RESPONSE
// ──────────────────────────────────────────────────────
async function sendPrompt(prompt, toolDefinitions) {
    // Test hook: bypass the browser entirely (used by smoke tests)
    if (process.env.TEST_FAKE_RESPONSE) {
        console.log(`🧪 TEST_FAKE_RESPONSE set — skipping browser (prompt: ${prompt.length} chars)`);
        return process.env.TEST_FAKE_RESPONSE;
    }

    // Refresh the CDP session per request — long-lived sessions intermittently
    // hang on evaluate while fresh ones always work (observed on Gemini).
    await initBrowser({ reconnect: true });
    await connectToWebchat(config.webchatUrl);
    console.log(`📤 Sending prompt (${prompt.length} chars)`);

    const fullPrompt = buildFullPrompt(prompt, toolDefinitions);

    let input;
    try {
        input = await typePrompt(fullPrompt);
    } catch (e) {
        // A page reload between lookup and type detaches the handle — retry once
        // with a fresh lookup before giving up.
        if (!/context destroyed|not an Element|detached/i.test(e.message)) throw e;
        console.log('🔄 typePrompt handle went stale — retrying once');
        await sleep(1500);
        input = await typePrompt(fullPrompt);
    }
    const before = await snapshotChat();
    await sendMessage(input, fullPrompt);

    console.log('⏳ Waiting for response...');
    const text = await waitForResponse(before, fullPrompt);
    console.log(`📥 Response received (${text.length} chars)`);

    await saveCookies(); // keep the session fresh
    return text;
}

// ── Type into the chat input ──
// Prefer the React-safe native-setter path (fast, works on textareas);
// contenteditable editors (Gemini, …) fall back to focused insertText.
// ⚠️ NEVER use page.keyboard.type() for multi-line prompts: it translates
// "\n" into Enter keypresses, which SENDS the partial message mid-prompt.
async function typePrompt(text) {
    const input = await firstMatch(config.selectors.input);
    if (!input) throw new Error('Chat input not found — is the session logged in?');

    const set = await page.evaluate((el, t) => {
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (desc && desc.set) {
            desc.set.call(el, t);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }
        return false;
    }, input, text);

    if (set) return input;

    // contenteditable: focus, clear, then insertText — newlines are
    // inserted literally (sendCharacter never synthesizes Enter).
    await input.scrollIntoView();
    await sleep(400);
    await input.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.sendCharacter(text);
    return input;
}

// ── Send: Enter on the focused input, click-fallback if it stays full. ──
// Enter-first avoids the mousedown-morph hazard on UIs where the send button
// turns into "Stop" while generating. DeepSeek's current build (08-12) treats
// Enter as newline — the input stays full, so we fall back to clicking
// div[role="button"].ds-button--primary, which fires send on mousedown
// (verified: textarea clears, message lands). The still-full check means the
// click path only ever runs when Enter genuinely didn't send.
//
// Retry on STALE handles: the SPA can re-render the composer between lookup
// and click (virtual-list recycle / hydration — observed 08-12 right after a
// fresh CDP attach: "Node is either not clickable or not an Element"). A page
// RELOAD wipes the typed text entirely, so each retry re-checks the box and
// re-types if it came back empty.
async function sendMessage(input, text) {
    for (let attempt = 0; ; attempt++) {
        try {
            // Headless tabs restore a deep scroll position (thread URL reload)
            // — the composer can be OFF-VIEWPORT (boundingBox y negative), and
            // clicking an out-of-view element throws "Node is either not
            // clickable or not an Element". Scroll it into view first.
            await input.scrollIntoView();
            await sleep(400);
            await input.click(); // focus without pressing the send button
            await page.keyboard.press('Enter');
            await sleep(1500);
            // If the text is still in the box, Enter didn't send — click the button.
            const stillFull = await page.evaluate((el) => {
                const v = el.value !== undefined ? el.value : el.innerText || '';
                return v.trim().length > 0;
            }, input);
            if (stillFull) {
                const btn = await firstMatch(config.selectors.send);
                if (btn) {
                    await btn.scrollIntoView();
                    await sleep(300);
                    // ⚠️ STOP-MORPH GUARD (08-12): while a generation is running
                    // the primary button morphs into STOP (same element, square
                    // glyph). Clicking it then KILLS the live answer — observed
                    // when a retried send landed mid-generation ("Stopped" toast,
                    // the in-flight reply destroyed, the retry's prompt stranded).
                    // A generation outliving its request happens when a client
                    // disconnects mid-reply: the abort stops the gateway loop but
                    // never stops the tab, so the next send's click is the first
                    // thing to touch the running generation. Only click once the
                    // button is back in SEND state (arrow glyph, d starts
                    // M8.3125; any other glyph = busy/stop, wait for it).
                    const sendGlyph = 'M8.3125';
                    const isSendState = await page.evaluate((el) => {
                        const d = ((el.querySelector('svg path') || { getAttribute: () => '' }).getAttribute('d') || '');
                        return d.startsWith('M8.3125');
                    }, btn).catch(() => true);
                    if (!isSendState) {
                        console.log('🛑 send button in STOP state — waiting for generation to finish');
                        for (let w = 0; w < 60; w++) {
                            await sleep(1000);
                            const ready = await page.evaluate((el) => {
                                const d = ((el.querySelector('svg path') || { getAttribute: () => '' }).getAttribute('d') || '');
                                return d.startsWith('M8.3125');
                            }, btn).catch(() => true);
                            if (ready) break;
                        }
                    }
                    await btn.click();
                    return;
                }
                await page.keyboard.press('Enter');
            }
            return;
        } catch (e) {
            const stale = /not clickable|not an Element|detached|context destroyed/i.test(e.message);
            if (!stale || attempt >= 2) throw e;
            console.log(`🔄 send handle went stale — re-resolving input (attempt ${attempt + 2})`);
            await sleep(1500);
            const fresh = await firstMatch(config.selectors.input);
            if (!fresh) throw e;
            const empty = await page.evaluate((el) => {
                const v = el.value !== undefined ? el.value : el.innerText || '';
                return v.trim().length === 0;
            }, fresh);
            input = fresh;
            if (empty) {
                console.log('🔄 composer was wiped (SPA reload?) — re-typing');
                input = await typePrompt(text);
            }
        }
    }
}

// ── Chat snapshot (build-agnostic) ─────────────────────────────
// DeepSeek's current build renders the thread in a VIRTUALIZED list
// (.ds-virtual-list, hashed CSS-module classes) — the old fixed selectors
// (.ds-markdown, .message, …) match nothing and count-based detection
// breaks (items are recycled, the count never grows). Instead: track the
// LAST RENDERED message's text — a new response replaces it, and streaming
// = it keeps growing until stable. Falls back to count-mode on older
// builds where the fixed selectors still exist.
async function snapshotChat() {
    return page.evaluate((sels) => {
        const vl = document.querySelector('.ds-virtual-list');
        if (vl) {
            // Virtual list renders only what's in view — the newest message is
            // only in the DOM at the bottom. Scroll first (React renders
            // synchronously on the scroll event, so the children below are
            // the CURRENT tail of the thread).
            vl.scrollTop = vl.scrollHeight;
            // 08-12: the list's DIRECT children are [spacer, items, spacer,
            // FOOTER] — the footer ("DeepThink | Search | AI-generated…") is
            // the last child with text but is NOT a message; reading it froze
            // detection forever. The messages live one level deeper: the
            // .ds-virtual-list-visible-items wrapper's children are discrete
            // message rows (user = _9663006-ish, assistant = _4f9bf79…).
            // Take the LAST non-empty child THERE.
            // ⚠️ querySelector with a comma-list returns the FIRST match in
            // document order — .ds-virtual-list-items (the PARENT) wins and
            // its single child is the whole block. Query visible-items
            // FIRST, separately (observed 08-12: parent-child ordering made
            // the comma-selector return the parent → 1789-char mega-row).
            const box = vl.querySelector('.ds-virtual-list-visible-items')
                || vl.querySelector('.ds-virtual-list-items')
                || vl;
            const scope = box || vl;
            const items = [...scope.children].filter((c) => (c.innerText || '').trim().length > 2);
            const last = items[items.length - 1];
            // 08-12: DeepSeek renders the model's REASONING inside the answer
            // row ("Thought for N seconds" header + .ds-think-content body).
            // The reasoning is first-person prose that plans the tool call in
            // code fragments full of { braces — concatenated into innerText it
            // poisoned parseToolCall (which scans from the FIRST '{' and never
            // advanced), so every valid tool-call reply was rejected as a yap:
            // the 2-rejections-before-every-call pattern. `text` stays RAW for
            // waitForResponse's growth/activity detection (the reasoning
            // streams and keeps the poll alive); `answer` is the row with the
            // think blocks REMOVED — that is the model's actual reply.
            const clone = last ? last.cloneNode(true) : null;
            if (clone) {
                clone.querySelectorAll('.ds-think-content').forEach((n) => n.remove());
                for (const h of [...clone.querySelectorAll('div, span')]) {
                    if (/^\s*Thought for \d+ seconds/.test(h.textContent || '')) h.remove();
                }
            }
            return {
                mode: 'vl',
                text: last ? last.innerText || '' : '',
                answer: clone ? clone.innerText || '' : '',
                lastCls: last ? (last.className || '').toString() : '',
                body: document.body ? document.body.innerText || '' : '',
            };
        }
        let n = 0;
        for (const s of sels) n += document.querySelectorAll(s).length;
        return { mode: 'count', count: n, text: '', body: document.body ? document.body.innerText || '' : '' };
    }, config.selectors.message);
}

// ── Wait until a NEW message appears and its text stops changing
//    across two polls (streaming models keep growing it) ──
// `before` is the snapshotChat() taken just before sending; `typedText`
// is the exact prompt we typed — the user message rendering it must NOT
// be accepted as the response (DeepSeek cogitates for seconds before its
// answer replaces it as the last item).
async function waitForResponse(before, typedText) {
    let deadline = Date.now() + config.timeout;
    // Absolute cap so a pathological never-ending stream can't hang the client
    // forever — activity may extend the deadline, but not past this.
    const hardCap = deadline + config.timeout * 5;
    let lastLen = -1; // forces at least two polls before accepting
    let lastAnswerLen = -1; // same for the think-stripped answer text (08-12)
    let lastText = null; // previous poll's thread text, for activity detection
    let emptySince = 0; // how long the newest message element has been empty
    while (Date.now() < deadline) {
        let state;
        try {
            state = await snapshotChat();
        } catch (e) {
            // If the BROWSER died (Chrome crash — observed 08-12), polling to
            // the deadline just hangs the client for the full timeout. Fail
            // fast with a clear error instead; the supervisor's chrome_cdp
            // ensure relaunches Chrome and the next request auto-resolves the
            // new ws id.
            if (!browser || !browser.isConnected() || page.isClosed()) {
                throw new Error('Webchat browser connection lost (Chrome crashed?) — please resend');
            }
            // Page busy (long cogitation / heavy render) — an evaluate can throw
            // ProtocolError mid-thought. That means "still generating", not failure:
            // keep polling until the deadline.
            console.log('⏳ poll evaluate failed (page busy?), retrying:', String(e.message).slice(0, 70));
            await sleep(1500);
            continue;
        }
        // User-row guard (08-12): the typedText contains-check is NOT enough —
        // DeepSeek's renderer consumes ```json fence markers into code-block
        // borders, so a rendered user row (which contains the whole gateway
        // prompt) does NOT contain the typed text verbatim. waitForResponse
        // then accepted the just-sent PROMPT as the response, parsed its own
        // format examples as a fake submit_answer, and the client got garbage
        // ("resume"/"hello??" → "✻ Churned for 3s", nothing delivered, while
        // the real answer sat undelivered in the tab). Rows are role-hashed:
        // user rows = class _9663006, assistant rows = _4f9bf79 (probed 08-12,
        // stable across builds). Never accept a user-class row.
        const USER_ROW_CLS = '_9663006';
        const userRow = (state.lastCls || '').split(/\s+/).includes(USER_ROW_CLS);
        const grew = state.mode === 'vl'
            ? !userRow && state.text !== before.text && state.text !== typedText && !state.text.includes(typedText)
            : state.count > before.count;
        // Accept on the THINK-STRIPPED answer text going stable (08-12): the
        // raw text is reasoning-only during cogitation, and accepting raw-text
        // stability could return just the thinking block (which then failed
        // the tool-call parse → the double-rejections before every tool call).
        // `answer` is empty while the model cogitates, so this never accepts
        // a reasoning-only pause. Fallback (count mode / older builds): the
        // raw-text check.
        if (state.mode === 'vl') {
            // Skip a "..."-only answer: it can be a streaming placeholder that
            // froze while the model cogitates — accepting it returns garbage.
            const answerText = (state.answer || '').trim();
            if (grew && answerText.length > 0 && answerText !== '…' && !/^\.{2,4}$/.test(answerText) && answerText.length === lastAnswerLen) {
                return state.answer;
            }
        } else if (grew && state.text.length > 0 && state.text.length === lastLen) {
            return state.text;
        }
        if (grew && state.text.length === 0) {
            // a new message element exists but has no text yet — if the chat
            // reports the response was stopped, that's a hard failure
            emptySince += 1500;
            if (state.body.includes('You stopped this response')) {
                throw new Error('Webchat response was stopped (Stop button pressed while generating)');
            }
            if (emptySince > 12000) {
                throw new Error('Webchat response is empty after 12s — stopped or aborted by the UI');
            }
        } else {
            emptySince = 0;
        }
        // Activity-reset: ANY thread movement (DeepSeek cogitating, streaming,
        // or working through earlier queued messages) extends the deadline —
        // a response arriving at 190s must not die on a 180s timer. The 1.5s
        // poll cadence means this only fires on real changes, never the steady
        // state that the stability check above accepts.
        if (state.mode === 'vl' && lastText !== null && state.text !== lastText) {
            deadline = Math.min(hardCap, Math.max(deadline, Date.now() + config.timeout));
        }
        lastText = state.text;
        lastLen = state.text.length;
        if (state.mode === 'vl') lastAnswerLen = state.answer ? state.answer.length : -1;
        await sleep(1500);
    }
    throw new Error(`Timed out after ${config.timeout}ms waiting for a response`);
}

// ──────────────────────────────────────────────────────
// 5. BUILD PROMPT WITH TOOLS
//    Tool definitions section is capped at TOOL_CONTEXT_WINDOW
//    chars so huge tool schemas don't eat the chat's context.
// ──────────────────────────────────────────────────────
function buildFullPrompt(userPrompt, toolDefinitions) {
    let fullPrompt = '';

    if (toolDefinitions && toolDefinitions.length > 0) {
        let section =
            'You have access to the tools below. ALWAYS respond with exactly one JSON object ' +
            '{"tool":"<name>","params":{...}} — never plain text, never prose (user rule 08-12). ' +
            'ALWAYS wrap it in a markdown code fence (```json ... ```) so this chat cannot corrupt your backticks. ' +
            'ONE tool call at a time. Use a real tool to perform work when the task needs it — you judge whether it ' +
            'does. When the task is complete (or it was a simple question needing no tools), submit your final ' +
            'plain-text answer via the submit_answer tool: {"tool":"submit_answer","params":{"text":"..."}}.\n\n';

        const toolsByCategory = {};
        for (const tool of toolDefinitions) {
            const cat = tool.category || 'general';
            if (!toolsByCategory[cat]) toolsByCategory[cat] = [];
            toolsByCategory[cat].push(tool);
        }

        for (const [category, tools] of Object.entries(toolsByCategory)) {
            section += `## ${category.toUpperCase()} TOOLS\n\n`;
            for (const tool of tools) {
                section += `- **${tool.name}**: ${tool.description}\n`;
                section += `  Params: ${JSON.stringify(tool.parameters)}\n\n`;
                if (section.length > config.toolContextWindow) {
                    section = section.slice(0, config.toolContextWindow) + '\n…(tool list truncated)\n';
                    break;
                }
            }
        }

        fullPrompt += section;
    }

    fullPrompt += `### USER REQUEST\n\n${userPrompt}\n\n### RESPONSE\n`;
    // Absolute final slot, after everything: this is the strongest instruction
    // position, and it must reinforce the format for EVERY round (first message
    // AND follow-ups) — DeepSeek's chat behavior is to pause after tool work
    // and write a progress report, which the middle-of-prompt rules don't kill.
    fullPrompt += 'REMINDER: your reply must be a fenced tool-call JSON (```json {"tool":"<name>","params":{...}} ```) ' +
        'or a fenced submit_answer (```json {"tool":"submit_answer","params":{"text":"..."}} ```). ' +
        'Plain text — including progress reports, summaries of what you did, and lists of "next steps" — is NEVER accepted.\n';
    return fullPrompt;
}

// ──────────────────────────────────────────────────────
// 6. CLEANUP
// ──────────────────────────────────────────────────────
async function closeBrowser() {
    if (browser) {
        await saveCookies();
        if (config.cdpWsUrl) {
            // CDP-attached: the browser belongs to the user — detach, never
            // shut it down. (browser.close() would kill their whole Chrome.)
            await browser.disconnect();
            console.log('🔌 Detached from CDP browser (left running).');
        } else {
            await browser.close();
            console.log('🔴 Browser closed.');
        }
        browser = null;
        page = null;
    }
}

// ──────────────────────────────────────────────────────
// 7. HELPERS + EXPORTS
// ──────────────────────────────────────────────────────
async function firstMatch(selectors) {
    for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) return el;
    }
    return null;
}

module.exports = {
    initBrowser,
    connectToWebchat,
    sendPrompt,
    closeBrowser,
    getPage: () => page,
    probePage,
};
