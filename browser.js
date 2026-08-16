const fs = require('fs');
const puppeteer = require('puppeteer');
const config = require('./config');

// 08-14 WEDGE ROOT-CAUSE guard: nothing legitimate is ever near this; it
// exists to turn a runaway tool result into a loud client-visible error
// instead of a silent gateway wedge (see sendPrompt).
const MAX_PROMPT_CHARS = parseInt(process.env.MAX_PROMPT_CHARS || '900000', 10);

let browser = null;
let page = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 08-14 EXPERT SWAP (user rule: deepseek webchat runs in EXPERT mode — mode
// is locked at thread creation, so an instant thread must be swapped to a
// fresh expert chat). sendPrompt records the fresh thread here when the swap
// fired; server.js consumes it via takeThreadSwap() and pins respawns, the
// same way a context-handoff pins its new thread.
let swappingToExpert = false;
let threadSwapSeen = null;
function takeThreadSwap() {
    const t = threadSwapSeen;
    threadSwapSeen = null;
    return t;
}

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
        // TAB_URL_SUBSTRING mode (second instance, 08-12): match the tab whose
        // URL contains the pinned thread id, never an arbitrary deepseek tab —
        // two gateway instances share one browser, each driving its own thread.
        if (config.tabUrlSubstring) {
            page = pages.find((p) => p.url().includes(config.tabUrlSubstring));
            if (!page) {
                console.log(`🆕 No tab matching ${config.tabUrlSubstring} — opening one`);
                page = await browser.newPage();
                await page.goto(webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }
        } else {
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
        }
        console.log(`🟢 Reusing tab: ${page.url()}`);
        // 08-13 VIEWPORT PIN (GUI-browser fix): on WM-less X sessions Chrome
        // renderers can freeze at the launch-time size — observed: every 9223
        // tab stuck at Chrome's default 800x600 while the X window was
        // 1920x1034 (page rendered quarter-size, window surface around it).
        // Resize events never reach the renderer, so pin the layout viewport
        // explicitly. VIEWPORT_W/H env — set ONLY for gateways driving a GUI
        // browser (headless deepseek instances leave it unset).
        if (config.viewportW && config.viewportH) {
            try {
                const s = await page.createCDPSession();
                await s.send('Emulation.setDeviceMetricsOverride', {
                    width: config.viewportW,
                    height: config.viewportH,
                    deviceScaleFactor: 1,
                    mobile: false,
                });
                await s.detach();
                console.log(`📐 Viewport pinned to ${config.viewportW}x${config.viewportH}`);
            } catch (e) {
                console.log('⚠️ viewport pin failed:', String(e.message).slice(0, 70));
            }
        }
        // 08-14 OPTIMIZATION (owner's guide): strip browser bloat at the
        // network layer — images/fonts/media (and stylesheets if BLOCKED_CSS=1)
        // are aborted; the chat app itself (document/script/xhr/fetch/
        // websocket) is untouched. Chrome's setBlockedURLs globs match
        // anywhere in the URL, so query-string'd assets are caught too.
        if (config.blockedUrls && config.blockedUrls.length) {
            try {
                const n = await page.createCDPSession();
                await n.send('Network.enable');
                await n.send('Network.setBlockedURLs', { urls: config.blockedUrls });
                await n.detach();
                console.log(`🚫 Asset blocking ON (${config.blockedUrls.length} patterns)`);
            } catch (e) {
                console.log('⚠️ asset blocking failed:', String(e.message).slice(0, 70));
            }
        }
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

    // 08-14 WEDGE ROOT-CAUSE hard guard: an uncapped tool result once made the
    // prompt 6,197,724 chars — the tab choked and the gateway wedged on
    // "Waiting for response..." for hours. Never send anything this absurd:
    // fail loudly to the client instead of silently wedging.
    if (prompt.length > MAX_PROMPT_CHARS) {
        throw new Error(`prompt too large (${prompt.length} chars > ${MAX_PROMPT_CHARS}) — refusing to send; a tool result or context build ran away. Check the caller.`);
    }

    // Refresh the CDP session per request — long-lived sessions intermittently
    // hang on evaluate while fresh ones always work (observed on Gemini).
    await initBrowser({ reconnect: true });
    await connectToWebchat(config.webchatUrl);
    // 08-14 (user rule): the deepseek webchat runs in EXPERT mode. An instant
    // thread (Search chip present) cannot be switched in place — swap to a
    // fresh EXPERT chat; the in-flight prompt becomes its first message.
    // EXPERT_SWAP_INSTANT=1 gates this to the instances that want it (8080 —
    // the telegram responder's thread must never be silently swapped).
    if (
        process.env.EXPERT_SWAP_INSTANT === '1' &&
        new URL(config.webchatUrl).host.includes('deepseek') &&
        (await isInstantThread())
    ) {
        console.log('🧪 pinned thread is INSTANT — swapping to a fresh EXPERT chat');
        swappingToExpert = true;
        await openNewChat();
    }
    // 08-14: keep DeepThink ON for the deepseek tab (expert mode has only the
    // DeepThink chip — Search is never touched). No-op for foreign webchats
    // (no such chips) and never throws.
    await ensureToggles();
    console.log(`📤 Sending prompt (${prompt.length} chars)`);

    // 08-13 FOREIGN-BUSY guard: a generation left running from a
    // disconnected client keeps its STOP control on the tab. Typing into
    // that composer strands the prompt (the send click targets the send
    // button, which is replaced by the stop control), and the wait then
    // rescues stale rows. Wait up to 60s for the tab to go idle, then fail
    // fast like the deepseek STOP wait does.
    if (!new URL(config.webchatUrl).host.includes('deepseek')) {
        for (let w = 0; w < 60; w++) {
            if (!(await isForeignBusy())) break;
            await sleep(1000);
        }
        if (await isForeignBusy()) {
            throw new Error('webchat tab still generating from a previous request — retry after it finishes');
        }
    }

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

    // 08-14 EXPERT-SWAP PIN: the first send on a fresh thread is what creates
    // it — capture the new /s/ id so server.js can pin respawns (mirrors the
    // handoff flow). Only when this send performed an expert swap.
    if (swappingToExpert) {
        swappingToExpert = false;
        const u = page.url();
        const m = u.match(/\/a\/chat\/s\/([0-9a-f-]+)/);
        if (m && m[1]) threadSwapSeen = { url: u, id: m[1] };
    }

    await saveCookies(); // keep the session fresh
    return text;
}

// 08-14 (user rule): the deepseek tab runs in EXPERT mode, which has ONLY the
// DeepThink chip (instant mode is the one with DeepThink + Search — the chip
// set IS the mode). So keep DeepThink on and NEVER touch Search: force-on it
// on an instant thread would lock that thread into instant. Idempotent, every
// request (a reload or tab flip can reset the chips). Foreign webchats have
// no such chips — harmless no-op.
async function ensureToggles() {
    try {
        const clicked = await page.evaluate(() => {
            const flipped = [];
            for (const el of document.querySelectorAll('.ds-toggle-button')) {
                const label = (el.textContent || '').trim();
                if (label !== 'DeepThink') continue;
                if (el.getAttribute('aria-pressed') === 'true') continue;
                el.click();
                flipped.push(label);
            }
            return flipped;
        });
        if (clicked && clicked.length) console.log('🧠 DeepThink enabled');
    } catch (e) {
        console.log('⚠ toggle ensure failed:', String(e.message).slice(0, 60));
    }
}

// 08-14 (user rule): instant mode = Search chip present, expert = DeepThink
// only. The chip set is the reliable mode detector — the mode itself is
// locked at thread creation and cannot be read from the URL.
async function isInstantThread() {
    try {
        return await page.evaluate(() =>
            [...document.querySelectorAll('.ds-toggle-button')].some(
                (el) => (el.textContent || '').trim() === 'Search'));
    } catch {
        return false; // fail-open: a DOM hiccup must never block a send
    }
}

// 08-14 (user rule): select EXPERT mode on a fresh new-chat page. Mode is
// locked at thread creation, so this works ONLY on the new-chat composer.
// 08-15 (USER CORRECTION): the Instant/Expert/Vision tabs were NEVER removed —
// they are a radiogroup (div.b0db7355, role="radio" options; dfb78875 = the
// unselected option's inner div, aa40b5de + _31a22b0 on the selected radio).
// My earlier probe missed them because they are NOT <button>s. The REAL expert
// check per owner rule: an expert composer has NO Search option at all —
// "if u see a search option that means its not expert". So select = click the
// Expert radio at creation, then VERIFY Search is absent (else it's instant).
// Never throws — a UI change just logs and continues rather than stalling.
async function selectExpertMode() {
    try {
        const flipped = await page.evaluate(() => {
            const out = [];
            const radios = [...document.querySelectorAll('[role="radiogroup"] [role="radio"]')];
            const expert = radios.find((r) => /expert/i.test(r.textContent || ''));
            if (!expert) {
                out.push('NO_MODE_TABS');
            } else {
                const isSel = expert.getAttribute('aria-checked') === 'true'
                    || (expert.className || '').includes('_31a22b0');
                if (!isSel) { expert.click(); out.push('Expert tab'); }
            }
            for (const el of document.querySelectorAll('.ds-toggle-button')) {
                const label = (el.textContent || '').trim();
                if (label === 'DeepThink' && el.getAttribute('aria-pressed') !== 'true') { el.click(); out.push('DeepThink ON'); }
            }
            return out;
        });
        await sleep(900); // composer re-renders for the selected mode
        const searchPresent = await page.evaluate(() =>
            [...document.querySelectorAll('.ds-toggle-button')].some(
                (el) => (el.textContent || '').trim() === 'Search'));
        if (searchPresent) {
            console.log('⚠ expert select FAILED — Search option still present (thread is INSTANT, not expert)');
        } else {
            console.log(flipped && flipped.length
                ? '🧠 new chat set to EXPERT mode (' + flipped.join(', ') + ') — Search absent, verified'
                : '🧠 already expert (no Search option, DeepThink on)');
        }
    } catch (e) {
        console.log('⚠ selectExpertMode failed:', String(e.message).slice(0, 60));
    }
}

// ── Type into the chat input ──
// Prefer the React-safe native-setter path (fast, works on textareas);
// contenteditable editors (Gemini, …) fall back to focused insertText.
// ⚠️ NEVER use page.keyboard.type() for multi-line prompts: it translates
// "\n" into Enter keypresses, which SENDS the partial message mid-prompt.
async function typePrompt(text) {
    // 08-12 23:30 handle-free (see sendMessage): query the LIVE element inside
    // the evaluate — no JSHandle args, nothing to detach when the SPA remounts
    // the composer on the input event.
    const set = await page.evaluate((sels, t) => {
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (desc && desc.set) {
                // 08-13 MULTI-SITE: focus BEFORE setting — the value-set path
                // never focused the input, so the later Enter press went to
                // whatever had focus last (qwen: a nav element → Enter
                // ACTIVATED it and navigated the tab to qwen.ai/home).
                el.focus();
                desc.set.call(el, t);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            return false; // found an element but it's not a value-setter input
        }
        return false;
    }, config.selectors.input, text);

    if (set) return;

    // contenteditable: focus, clear, then insertText — newlines are
    // inserted literally (sendCharacter never synthesizes Enter).
    await page.evaluate((sels) => {
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); return; }
        }
    }, config.selectors.input);
    await sleep(400);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.sendCharacter(text);
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
    // 08-12 23:30 HANDLE-FREE REWRITE: JSHandle-argument evaluates
    // (page.evaluate(fn, elementHandle)) HANG on this DeepSeek build — the
    // composer's input event remounts the textarea, the handle goes detached,
    // and Chromium's callFunctionOn on a detached objectId times out at the
    // 120s protocolTimeout instead of erroring (observed: every request dying
    // on "Runtime.callFunctionOn timed out" while handle-free probes answered
    // in milliseconds — the typed prompt sat in the composer unsent). This
    // version uses page-level evaluates (querySelector inside, serializable
    // args only), CDP Input for the Enter press, and page.mouse.click by
    // fresh coordinates for the send button — no JSHandles, nothing to detach.
    // 08-13: arm the in-page stream tee before any send — the answer is
    // read from the completion XHR body, not the DOM (which stopped
    // rendering responses in this environment). Idempotent; re-arms itself
    // after navigations / context handoffs.
    await installStreamTee().catch((e) => console.log('⚠ stream tee install failed:', String(e.message).slice(0, 60)));
    for (let attempt = 0; ; attempt++) {
        try {
            // Headless tabs restore a deep scroll position (thread URL reload)
            // — the composer can be OFF-VIEWPORT (boundingBox y negative), and
            // clicks on it throw "Node is either not clickable or not an
            // Element". Scroll the LIVE composer into view and focus it.
            await page.evaluate((sels) => {
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); return true; }
                }
                return false;
            }, config.selectors.input);
            await sleep(400);
            // 08-14 GEMINI FIX: programmatic el.focus() does not activate
            // gemini's editor — Enter is then ignored and the send-button
            // fallback can misfire (it once opened the model picker instead
            // of sending). A trusted mouse click on the composer activates
            // it; Enter then sends (verified 08-14 on the 9224 driver).
            // DeepSeek's composer handles focus() fine — keep its proven path.
            if (!new URL(config.webchatUrl).host.includes('deepseek')) {
                const cRect = await page.evaluate((sels) => {
                    for (const sel of sels) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    }
                    return null;
                }, config.selectors.input);
                if (cRect) {
                    await page.mouse.click(cRect.x, cRect.y);
                    await sleep(300);
                }
            }
            // 08-13 NEVER-SEND-EMPTY guard: if typing silently failed (composer
            // remounted mid-request, stale element), Enter would fire with an
            // empty box — DeepSeek shows "Message is empty" and the wait hangs
            // (observed on the 08-13 f05a02e4 tab). Verify the text landed;
            // retype once; only then send.
            let landed = await page.evaluate((sels) => {
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const v = el.value !== undefined ? el.value : el.innerText || '';
                    if (v.trim().length > 0) return true;
                }
                return false;
            }, config.selectors.input);
            if (!landed) {
                console.log('⚠️ composer empty after typing — retyping once');
                await typePrompt(text);
                landed = await page.evaluate((sels) => {
                    for (const sel of sels) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const v = el.value !== undefined ? el.value : el.innerText || '';
                        if (v.trim().length > 0) return true;
                    }
                    return false;
                }, config.selectors.input);
                if (!landed) throw new Error('composer stayed empty after typing — send aborted (no empty sends)');
            }
            await page.keyboard.press('Enter');
            await sleep(1500);
            // If the text is still in the box, Enter didn't send — click the button.
            const stillFull = await page.evaluate((sels) => {
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const v = el.value !== undefined ? el.value : el.innerText || '';
                    if (v.trim().length > 0) return true;
                }
                return false;
            }, config.selectors.input);
            if (stillFull) {
                const btnInfo = await page.evaluate((sels) => {
                    for (const sel of sels) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const d = ((el.querySelector('svg path') || { getAttribute: () => '' }).getAttribute('d') || '');
                        const r = el.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) continue;
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2, glyph: d.slice(0, 8) };
                    }
                    return null;
                }, config.selectors.send);
                if (btnInfo) {
                    // scroll the button into view before clicking (off-viewport
                    // clicks land nowhere)
                    await page.evaluate((sels) => {
                        for (const sel of sels) {
                            const el = document.querySelector(sel);
                            if (el) { el.scrollIntoView({ block: 'center' }); return; }
                        }
                    }, config.selectors.send);
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
                    // 08-13 MULTI-SITE: the M8.3125 send-glyph check is
                    // DeepSeek-UI-specific — on qwen/kimi/gemini the send
                    // button's icon differs and would read as perpetual STOP
                    // (observed: gemini's probe blocked by a false-STOP wait).
                    // The server-level busy guard already serializes requests,
                    // so no live generation can be running here: click
                    // directly on foreign sites.
                    const isDeepseek = new URL(config.webchatUrl).host.includes('deepseek');
                    let ready = !isDeepseek || btnInfo.glyph.startsWith('M8.3125');
                    if (!ready) {
                        console.log('🛑 send button in STOP state — waiting for generation to finish');
                        for (let w = 0; w < 120; w++) {
                            await sleep(1000);
                            ready = await page.evaluate((sels) => {
                                for (const sel of sels) {
                                    const el = document.querySelector(sel);
                                    if (!el) continue;
                                    const d = ((el.querySelector('svg path') || { getAttribute: () => '' }).getAttribute('d') || '');
                                    return d.startsWith('M8.3125');
                                }
                                return false;
                            }, config.selectors.send);
                            if (ready) break;
                        }
                        // 08-12 23:15 NEVER click a still-STOP button: the click
                        // would STOP the live generation ("Stopped" toast, reply
                        // destroyed) and wedge the next retry — the exact chain
                        // that ate the 2nd session's requests after a mid-flight
                        // kill. Fail fast instead; the generation keeps running,
                        // the client's retry finds a clean SEND button.
                        if (!ready) {
                            throw new Error('webchat tab still generating from a previous request — retry after it finishes');
                        }
                    }
                    // Re-read fresh coordinates right before the click (the SPA
                    // may have re-laid-out since the first read).
                    const pos = await page.evaluate((sels) => {
                        for (const sel of sels) {
                            const el = document.querySelector(sel);
                            if (!el) continue;
                            const r = el.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                        }
                        return null;
                    }, config.selectors.send);
                    if (!pos) throw new Error('send button vanished before click');
                    await page.mouse.click(pos.x, pos.y);
                    return;
                }
                await page.keyboard.press('Enter');
            }
            return;
        } catch (e) {
            const stale = /not clickable|not an Element|detached|context destroyed/i.test(e.message);
            if (!stale || attempt >= 2) throw e;
            console.log(`🔄 send flow hit a stale handle — re-typing (attempt ${attempt + 2})`);
            await sleep(1500);
            input = await typePrompt(text);
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
                count: items.length, // message-row count (08-13: growth check)
            };
        }
        // 08-13 MULTI-SITE: foreign webchats (qwen/kimi/gemini) render replies
        // in normal DOM — count mode must also carry the NEWEST text-bearing
        // matched row, or waitForResponse can never accept their answers
        // (deepseek's virtual list uses 'vl' mode above). Selectors are
        // iterated in order; matches are in document order, so the last
        // text-bearing one is the newest message (sidebar rows come earlier).
        let n = 0;
        let lastEl = null;
        const seen = new Set();
        const recent = [];
        for (const s of sels) {
            for (const el of document.querySelectorAll(s)) {
                // If el is contained inside an already seen container, skip nested duplicate
                let isNested = false;
                for (const prev of seen) {
                    if (prev.contains(el)) { isNested = true; break; }
                }
                if (isNested) continue;

                const t = (el.innerText || '').trim();
                const isUserRow = el.tagName === 'USER-QUERY'
                    || (el.getAttribute && el.getAttribute('data-message-author-role') === 'user')
                    || /^You have access to the tools below/.test(t)
                    || /### SYSTEM INSTRUCTION|### USER MESSAGE/.test(t);
                if (isUserRow) continue;

                n++;
                seen.add(el);
                lastEl = el;
                if (t.length > 0) {
                    recent.push(el);
                    if (recent.length > 3) recent.shift();
                }
            }
        }
        let txt = lastEl ? (lastEl.innerText || '').slice(0, 100000) : '';
        if (recent.length > 1 && txt.includes('{') && /tool/.test(txt)) {
            const joined = recent.map((e) => e.innerText || '').join('\n');
            txt = joined.slice(0, 100000);
        }
        return { mode: 'count', count: n, text: txt, answer: txt, lastCls: lastEl ? (lastEl.className || '').toString() : '', body: document.body ? document.body.innerText || '' : '' };
    }, config.selectors.message);
}

// STOP-glyph check (08-13, hoisted out of the wait loop): DeepSeek shows the
// STOP icon on the send button while a generation runs and reverts to the
// send glyph when done. Handle-free — queries the live element in-page.
async function isGenerating() {
    try {
        return await page.evaluate((sels) => {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (!el) continue;
                const d = ((el.querySelector('svg path') || { getAttribute: () => '' }).getAttribute('d') || '');
                return d.length > 0 && !d.startsWith('M8.3125');
            }
            return false;
        }, config.selectors.send);
    } catch { return false; }
}

// Count-mode generation detector (08-13): foreign webchats (qwen/kimi/
// gemini) don't share DeepSeek's M8.3125 STOP glyph, so isGenerating()
// can't read them. While a generation runs they show a stop control
// (element whose aria-label or button text is exactly stop-ish; Chinese
// labels included — qwen/kimi are zh UIs). Its presence ⇒ the newest row
// is still streaming — never accept or rescue it, never type into it.
async function isForeignBusy() {
    try {
        return await page.evaluate(() => {
            const stopish = (s) => {
                s = (s || '').trim().toLowerCase();
                return s === 'stop' || s === 'stop response' || s === 'stop generating'
                    || s === 'stop generation' || s === 'stop stream'
                    || s === '停止' || s === '停止生成' || s === '停止响应';
            };
            const isVisible = (el) => {
                if (!el) return false;
                if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null) return false;
                if (el.getAttribute('aria-hidden') === 'true') return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
                return el.offsetParent !== null || el.getClientRects().length > 0;
            };
            for (const el of document.querySelectorAll('[aria-label]')) {
                if (stopish(el.getAttribute('aria-label')) && isVisible(el)) return true;
            }
            for (const b of document.querySelectorAll('button')) {
                if (stopish(b.innerText) && isVisible(b)) return true;
            }
            return false;
        });
    } catch { return false; }
}

// ── SSE STREAM TEE (08-13) ──────────────────────────────────
// DeepSeek 2.3.0's frontend stopped committing streamed responses to the
// DOM in this headless environment — the completion XHR streams real tokens
// (probed 08-13: `data: {"v":{"response":{...,"fragments":[{"type":
// "RESPONSE","content":"P"}],"status":"WIP"}}}` on a 200 text/event-stream),
// but the virtual list never renders them, so DOM polling times out on
// every request. Fix: tee the completion response in-page and read the
// answer from the stream body directly. The app's http client uses
// XMLHttpRequest (proven by the 08-13 tee capture); fetch is hooked too as
// a transport fallback. Idempotent per page load — call from sendMessage
// before every send so a navigation or context-handoff re-arms it on the
// fresh document.
async function installStreamTee() {
    await page.evaluate(() => {
        // 08-13 CAP BUG FIX: seq-tagged entries (see push()/readStreamedAnswer).
        // If an older build armed a seq-less tee on this long-lived page,
        // RE-ARM it — stale entries belong to dead requests anyway.
        // 08-13 PARSER-REFRESH: __wsParseSse is assigned BEFORE the guard —
        // gateway restarts must reach already-armed pages, or code fixes to
        // the parser never apply (the page keeps the old function forever and
        // the "restart to fix it" cycle silently does nothing). The buffer and
        // XHR/fetch interceptors below stay guarded — they are stateful and
        // must not double-install.
        window.__wsParseSse = function (body) {
            // 08-15 DRIFT: `think` carries the model's PRIVATE THINKING (the
            // DeepThink reasoning streamed BEFORE the RESPONSE fragment is
            // declared, plus THINK fragment content) — readStreamedAnswer
            // accumulates it into window.__wsThinkBuf for the drift detector.
            const out = { text: '', think: '', done: false, error: '' };
            // 08-13 DeepThink gate: with thinking_enabled the think block
            // streams FIRST as bare {"v":...} chunks + -1/content APPENDs,
            // while the v-response frame declares fragments[last].type as
            // THINK. Only after a RESPONSE fragment is declared do those
            // chunks belong to the answer (probed live 08-13: fragment id 2
            // THINK → id 3 RESPONSE). Without the gate the extracted text is
            // reasoning + JSON — the 08-12 DOM-path poison, now on the tee.
            let streamingResponse = false;
            const blocks = String(body || '').split('\n\n');
            for (const block of blocks) {
                if (/^event:\s*(done|finished)/im.test(block)) out.done = true;
                // 08-13 RATE-LIMIT FIX: burst traffic gets
                //   event: hint
                //   data: {"type":"error","content":"Messages too frequent. Try
                //     again later.","finish_reason":"rate_limit_reached"}
                // then `event: close` and NOTHING else — status never SETs
                // FINISHED, so without this the wait loop polls to the full
                // timeout, the client retries, and each retry re-hammers the
                // same limit (the 08-13 "stops mid task" doom loop). Treat it
                // as terminal and surface the error text.
                if (/^event:\s*hint/im.test(block)) {
                    for (const line of block.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        try {
                            const j = JSON.parse(line.slice(5).trim());
                            if (j && j.type === 'error') {
                                out.done = true;
                                out.error = String(j.content || 'deepseek stream error');
                                if (j.finish_reason) out.error += ' (finish_reason: ' + j.finish_reason + ')';
                            }
                        } catch { /* not JSON */ }
                    }
                }
                for (const line of block.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const raw = line.slice(5).trim();
                    if (!raw) continue;
                    let j;
                    try { j = JSON.parse(raw); } catch { continue; }
                    if (j && typeof j.finish_reason === 'string' &&
                        /rate_limit_reached|error|content_filter/i.test(j.finish_reason)) {
                        out.done = true;
                        out.error = out.error || ('stream finished with finish_reason: ' + j.finish_reason);
                    }
                    // OLD format: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"..."}],"status":"WIP"}}}
                    const resp = j && j.v && j.v.response;
                    if (resp) {
                        const st = resp.status || '';
                        if (st === 'DONE' || st === 'FINISHED' || st === 'ERROR' || st === 'STOPPED') out.done = true;
                        if (Array.isArray(resp.fragments)) {
                            const lastFrag = resp.fragments[resp.fragments.length - 1];
                            if (lastFrag && lastFrag.type === 'RESPONSE') streamingResponse = true;
                            else if (lastFrag && lastFrag.type === 'THINK') streamingResponse = false;
                            for (const f of resp.fragments) {
                                if (f && typeof f.content === 'string') {
                                    if (f.type === 'RESPONSE') out.text += f.content;
                                    else if (f.type === 'THINK') out.think += f.content;
                                }
                            }
                        }
                    }
                    // NEW 2.3.0 format (probed 08-13 — the old format is gone
                    // from live streams): content arrives as APPEND patches on
                    // response/fragments/-1/content, or as BARE {"v":"<string>"}
                    // chunks, and completion is signalled by
                    // {"p":"response/status","o":"SET","v":"FINISHED"} (or a
                    // BATCH with quasi_status) plus `event: close`. Gated on
                    // streamingResponse so DeepThink reasoning never mixes in.
                    //
                    // The RESPONSE fragment is declared mid-stream as a PATCH:
                    // {"p":"response/fragments","o":"APPEND","v":[{"id":3,
                    // "type":"RESPONSE","content":"```",...}]} — the answer
                    // chunk after it also arrives WITHOUT "o" on -1/content
                    // (frame "json" above) — accept any -1/content patch, and
                    // treat the fragments APPEND patch as the gate switch.
                    if (j && j.p === 'response/fragments' && j.o === 'APPEND' && Array.isArray(j.v) && j.v.length) {
                        const lastFrag = j.v[j.v.length - 1];
                        if (lastFrag && lastFrag.type === 'RESPONSE') {
                            streamingResponse = true;
                            if (typeof lastFrag.content === 'string') out.text += lastFrag.content;
                        } else if (lastFrag && lastFrag.type === 'THINK') {
                            streamingResponse = false;
                            if (typeof lastFrag.content === 'string') out.think += lastFrag.content;
                        }
                    }
                    if (j && typeof j.v === 'string' && j.p && /content/.test(j.p)) {
                        if (streamingResponse) out.text += j.v;
                        else out.think += j.v; // pre-RESPONSE bare chunks = reasoning
                    } else if (j && typeof j.v === 'string' && !j.p) {
                        if (streamingResponse) out.text += j.v;
                        else out.think += j.v; // pre-RESPONSE bare chunks = reasoning
                    }
                    if (j && j.p === 'response/status' && typeof j.v === 'string') {
                        if (j.v === 'FINISHED' || j.v === 'DONE' || j.v === 'ERROR' || j.v === 'STOPPED') out.done = true;
                    }
                    if (j && j.p === 'response/quasi_status' && typeof j.v === 'string') {
                        if (j.v === 'FINISHED' || j.v === 'DONE') out.done = true;
                    }
                    if (j && j.p === 'response' && j.o === 'BATCH' && Array.isArray(j.v)) {
                        for (const sub of j.v) {
                            if (sub && sub.p === 'quasi_status' && (sub.v === 'FINISHED' || sub.v === 'DONE')) out.done = true;
                        }
                    }
                    if (j && typeof j.biz_code === 'number' && j.biz_code !== 0) out.done = true;
                }
            }
            return out;
        };
        // 08-13 VERSIONED RE-ARM: the guard below must NOT skip an upgrade —
        // a long-lived page keeps the interceptor closure it got at install,
        // so code fixes (the 08-13 request-body capture) never reached pages
        // armed by an older build and the handoff pre-check read 0 forever.
        // New installs wrap the old wrapper (chain: new → old → real send);
        // push dedupes consecutive identical bodies so an upgrade never
        // doubles entries. The buffer/seq survive the upgrade — the reader
        // takes a seq snapshot at entry and skips everything older.
        if (window.__wsTeeV === 2) return;
        if (!window.__wsTee || typeof window.__wsTeeSeq !== 'number') {
            window.__wsTee = [];
            window.__wsTeeSeq = 0;
        }
        window.__wsTeeV = 2;
        // XHR/fetch interceptors (buffer pushes — the parser above is the
        // only per-install part; re-wrapping is safe thanks to the dedupe).
        const push = (body) => {
            const s = String(body || '');
            const prev = window.__wsTee[window.__wsTee.length - 1];
            if (prev && prev.body === s) return; // upgrade double-wrap dedupe
            // seq is monotonic and survives the 32-entry eviction — the
            // reader matches on seq, not array position (see the CAP BUG
            // comment in readStreamedAnswer).
            window.__wsTee.push({ body: s, at: Date.now(), seq: ++window.__wsTeeSeq });
            // 08-13 WEDGE FIX: 8 entries was evicting long tool-loop streams
            // (compaction/tool runs push many completion XHRs); 32 keeps the
            // window safe for any serialized burst.
            if (window.__wsTee.length > 32) window.__wsTee.shift();
        };
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (m, u, ...rest) {
            this.__wsUrl = String(u || '');
            return origOpen.call(this, m, u, ...rest);
        };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (...args) {
            const x = this;
            if (x.__wsUrl && x.__wsUrl.includes('/api/v0/chat/completion')) {
                // 08-13 CONTEXT-HANDOFF: capture the REQUEST body size at send
                // time — DeepSeek's cap is per-request (history + system +
                // tools + message, observed failing at ~135k chars / ~32k
                // tokens), so this length is the true context measure. Set on
                // send (not loadend) so a request that FAILS with
                // context_length_exceeded still records how big it was.
                window.__wsTeeReqBodyChars = String(args[0] || '').length;
                x.addEventListener('loadend', () => { if (x.status === 200) push(x.responseText); });
            }
            return origSend.apply(this, args);
        };
        const origFetch = window.fetch;
        window.fetch = function (u, o) {
            const p = origFetch.apply(this, arguments);
            if (String(u || '').includes('/api/v0/chat/completion')) {
                const body = (o && o.body) ? String(o.body) : '';
                if (body.length) window.__wsTeeReqBodyChars = body.length;
                p.then((r) => r.clone().text()).then(push).catch(() => {});
            }
            return p;
        };
    });
}

// Read the last completion REQUEST body size (chars) recorded by the tee.
// 0 = nothing captured yet (fresh thread / tee just reset) — callers treat
// that as "no history, never hand off".
async function getReqBodyChars() {
    try { return await page.evaluate(() => window.__wsTeeReqBodyChars || 0); } catch { return 0; }
}

// 08-15 DRIFT: read + reset the page's accumulated THINK (reasoning) text —
// the drift detector's input for the exchange that just finished.
async function getAndClearThinkBuf() {
    try {
        return await page.evaluate(() => {
            const t = window.__wsThinkBuf || '';
            window.__wsThinkBuf = '';
            return t;
        });
    } catch { return ''; }
}

// After a context-handoff thread swap the page's counters describe the OLD
// thread — a stale ~threshold-sized body would immediately re-trigger a
// handoff on the fresh chat. Clear the request-size record and the stream
// buffer (its entries belong to the old thread's requests; the reader takes
// a seq snapshot at entry, so zeroing the seq is safe between requests).
async function resetTeeForHandoff() {
    try {
        await page.evaluate(() => {
            window.__wsTeeReqBodyChars = 0;
            window.__wsTee = [];
            window.__wsTeeSeq = 0;
        });
    } catch { /* page busy — the next send re-arms/overwrites anyway */ }
}

// 08-13 WEDGE FIX: a DOM answer that "stopped growing" mid-stream is NOT a
// complete answer — the webchat can pause between chunks while `busy` reads
// false, and accepting the fragment burned rounds until the client gave up
// ("API error · Retrying"). Called on the DOM-accept path only; the stream
// tee is always preferred and holds the complete body at loadend.
function looksLikeTruncatedAnswer(text) {
    if (!text) return true;
    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 !== 0) return true;                 // unclosed fence
    const open = text.lastIndexOf('```');
    if (open !== -1) {
        // Unclosed fence is already caught by parity above; here the fence is
        // closed — parse its block as JSON. A tool-call answer that fails to
        // parse is mid-stream (or broken) → keep polling. Note: a complete
        // fenced answer legitimately ENDS right after the closing fence, so
        // an empty tail here is normal, not a signal.
        const m = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
        if (m) { try { JSON.parse(m[1]); } catch { return true; } }
    }
    // Dangling tool-JSON tails (fenceless replies / partial render):
    if (/("tool"\s*:\s*"[^"]*"\s*,\s*"params"\s*:\s*\{)[^{}]*$/.test(text)) return true;
    if (/"params"\s*:\s*\{\s*$/.test(text)) return true;
    return false;
}

// Read the newest tee entry at or after `startIndex` (the tee length at
// waitForResponse entry — excludes entries belonging to earlier requests;
// the send queue is serialized so anything newer is THIS request). Entries
// are pushed at loadend, so the body is complete whenever found=true.
async function readStreamedAnswer(startIndex) {
    try {
        return await page.evaluate((start) => {
            const tee = window.__wsTee || [];
            if (typeof window.__wsParseSse !== 'function') return { found: false, text: '', done: false, error: '' };
            let found = false, text = '', done = false, error = '';
            // 08-13 CAP BUG: past 32 entries the tee evicts its oldest, so a
            // new push leaves length EXACTLY at 32 — an index-based read from
            // `start` (= length at waitForResponse entry) never ran again and
            // every answer after the tee saturated timed out. Entries carry a
            // monotonic seq; match on it (legacy seq-less entries fall back
            // to position).
            for (let i = 0; i < tee.length; i++) {
                const e = tee[i];
                const isNew = (e.seq !== undefined) ? e.seq > start : i >= start;
                if (!isNew) continue;
                found = true;
                const p = window.__wsParseSse(e.body);
                text = p.text;
                done = p.done;
                error = p.error || error; // last error wins; empty stays empty
                if (p.think) {
                    // 08-15 DRIFT: the model's PRIVATE THINKING accumulates
                    // here (capped — scoring needs a window, not the whole
                    // session); the gateway reads + clears it via
                    // getAndClearThinkBuf at the end of each exchange.
                    window.__wsThinkBuf = ((window.__wsThinkBuf || '') + p.think).slice(-40000);
                }
            }
            return { found, text, done, error };
        }, startIndex);
    } catch { return { found: false, text: '', done: false, error: '' }; }
}

// ── Wait until a NEW message appears and its text stops changing
//    across two polls (streaming models keep growing it) ──
// `before` is the snapshotChat() taken just before sending; `typedText`
// is the exact prompt we typed — the user message rendering it must NOT
// be accepted as the response (DeepSeek cogitates for seconds before its
// answer replaces it as the last item).
async function waitForResponse(before, typedText) {
    // 08-13 SSE-TEE: the completion XHR's streamed body is now the primary
    // answer source (the DOM stopped rendering responses in this env). Tee
    // entries are pushed at loadend — anything at/after this index appeared
    // while WE poll, so it belongs to this request (the queue is serialized).
    // 08-13 CAP BUG FIX: track the tee by seq — length-based starts break once
    // eviction keeps length pinned at 32 (new entries were invisible forever).
    const teeStart = await page.evaluate(() => (window.__wsTeeSeq || 0)).catch(() => 0);
    let deadline = Date.now() + config.timeout;
    // Absolute cap so a pathological never-ending stream can't hang the client
    // forever — activity may extend the deadline, but not past this.
    const hardCap = deadline + config.timeout * 5;
    let lastLen = -1; // forces at least two polls before accepting
    let lastAnswerLen = -1; // same for the think-stripped answer text (08-12)
    let lastText = null; // previous poll's thread text, for activity detection
    let emptySince = 0; // how long the newest message element has been empty
    while (Date.now() < deadline) {
        // 08-13: stream tee FIRST — the DOM may never render the answer in
        // this environment. found=true means loadend fired, so the body is
        // complete; return it without waiting on the UI.
        try {
            const tee = await readStreamedAnswer(teeStart);
            if (tee.found) {
                // 08-13 RATE-LIMIT FIX: the stream can end with a hint-error
                // (e.g. "Messages too frequent") — nothing else ever arrives.
                // Fail fast with the error text; a hung client retries, and
                // each retry re-hammers the same account limit.
                if (tee.error) throw new Error('DeepSeek stream error: ' + tee.error + ' — wait ~30s and retry');
                if (tee.text.trim().length > 0) return tee.text;
                if (tee.done) throw new Error('Webchat stream ended without content (error status in stream)');
            }
        } catch (e) {
            if (e.message && /stream ended without content|stream error/.test(e.message)) throw e;
            // otherwise (page busy / evaluate race) fall through to the DOM poll
        }
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
        // 08-13: newer rows hash to _81e7b5e (probed live) — the hash-only
        // check missed them, and the last row after a send is often the
        // gateway's own tool-preamble USER row, which the DOM path could
        // accept as the answer. Guard on hash OR the preamble prefix.
        const userRow = (state.lastCls || '').split(/\s+/).includes(USER_ROW_CLS)
            || (state.lastCls || '').split(/\s+/).includes('_81e7b5e')
            || /^You have access to the tools below/.test(state.answer || '');
        // Growth via ROW COUNT (08-13): the text-inequality check alone never
        // trips when the new answer renders IDENTICAL to the previous one —
        // every response on the personal thread (6187afed) then burned the
        // full timeout and was only rescued at deadline. Count growth covers
        // that; text comparison stays as a fallback for virtual-list
        // recycling that fluctuates the count.
        const grew = state.mode === 'vl'
            ? !userRow && (state.count !== before.count || (state.text !== before.text && state.text !== typedText && !state.text.includes(typedText)))
            : state.count > before.count;
        // Accept on the THINK-STRIPPED answer text going stable (08-12): the
        // raw text is reasoning-only during cogitation, and accepting raw-text
        // stability could return just the thinking block (which then failed
        // the tool-call parse → the double-rejections before every tool call).
        // `answer` is empty while the model cogitates, so this never accepts
        // a reasoning-only pause. Fallback (count mode / older builds): the
        // raw-text check.
        const busy = state.mode === 'vl' ? await isGenerating() : await isForeignBusy();
        if (state.mode === 'vl') {
            // Skip a "..."-only answer: it can be a streaming placeholder that
            // froze while the model cogitates — accepting it returns garbage.
            const answerText = (state.answer || '').trim();
            // Accept on generation END (08-13): the send button reverts from
            // STOP to the send glyph when DeepSeek finishes (it flips to STOP
            // before the first token, so idle ⇒ the row is complete). Text
            // stability alone was unreliable here — the 21:21 PONG only
            // arrived via the deadline rescue — so accept as soon as a
            // non-empty answer exists AND the button is idle.
            // 08-13 WEDGE FIX: require (a) length stable across TWO polls
            // (lastAnswerLen === this length), (b) button idle, (c) the text
            // not visibly truncated. The old `|| !busy` accepted a mid-stream
            // fragment the moment `busy` read false between chunks — that
            // 36-char truncation is what wedged the session at 95% context.
            // The stream tee (complete at loadend) is re-checked first and
            // wins whenever it has the body.
            if (grew && answerText.length > 0 && answerText !== '…' && !/^\.{2,4}$/.test(answerText) && answerText.length === lastAnswerLen && !busy) {
                const teeNow = await readStreamedAnswer(teeStart);
                if (teeNow.found && teeNow.text.trim().length > 0) return teeNow.text;
                if (!looksLikeTruncatedAnswer(answerText)) return state.answer;
                // else: mid-stream fragment — do NOT accept; keep polling
            }
        } else if (grew && state.text.length > 0 && state.text.length === lastLen && state.text !== before.text) {
            // 08-13 MULTI-SITE: same '…'/dots placeholder guard as the vl path
            // — gemini's composer renders a "…" row while cogitating and the
            // count-mode accept returned it as the final answer. The !busy
            // requirement (08-13) defers acceptance until the stop control
            // clears — streaming rows grow in count AND text, and accepting
            // them mid-stream returned fragments and stale rescues.
            // 08-16 GEMINI PHANTOM-STOP FIX (scoped to gemini ONLY, user
            // 08-16): gemini keeps its "Stop response" control in the DOM
            // after the answer commits (unclickable, persists for minutes),
            // so isForeignBusy() stays true and the !busy gate never fired —
            // every gemini request burned the full timeout + rescue. A STABLE
            // answer carrying a complete tool JSON (gemini's reply format:
            // `JSON\n{"tool":"submit_answer","params":{...}}`) is the finished
            // reply — accept it even while the phantom stop is up. Other
            // sites' stop controls are trusted, so they keep the strict gate.
            const ctext = state.text.trim();
            if (ctext === '…' || /^\.{2,4}$/.test(ctext)) { await sleep(1500); continue; }
            if (busy) {
                const isGemini = new URL(config.webchatUrl).host.includes('gemini');
                const toolDone = isGemini
                    && /"tool"\s*:\s*"/.test(ctext)
                    && (/\{\s*"tool"/.test(ctext) || /submit_answer|"params"/.test(ctext))
                    && /\}\s*$/.test(ctext);
                const plainTextDone = config.allowPlainText && ctext.length > 0;
                if (!toolDone && !plainTextDone) { await sleep(1500); continue; }
            }
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
        // Silent-generation signal (08-12 23:55): with DeepThink off the model
        // cogitates SILENTLY — no text movement for minutes while the send
        // button shows STOP (a generation is running). The text-activity reset
        // above misses that, so long cogitations died on the 180s deadline
        // with a complete answer arriving seconds later. STOP state extends
        // the deadline exactly like text activity does. 08-13: extended to
        // count-mode sites — a running generation there means the newest row
        // is still streaming, so the deadline must not expire into a stale
        // rescue (gemini's 20197-char request rescued a 22-char stale row).
        if (busy) {
            deadline = Math.min(hardCap, Math.max(deadline, Date.now() + config.timeout));
        }
        lastText = state.text;
        lastLen = state.text.length;
        if (state.mode === 'vl') lastAnswerLen = state.answer ? state.answer.length : -1;
        await sleep(1500);
    }
    // Rescue (08-12): the deadline expired but a complete answer is sitting on
    // the tab (the model finished just after the last poll). Deliver it
    // instead of failing the request — the answer is real model output and
    // the round logic (tool parse / format check) handles it normally.
    // 08-13 WEDGE FIX: while the model is STILL GENERATING past the deadline
    // (long cogitations on big tasks), keep waiting — bounded by the hard cap —
    // instead of throwing. A throw here is exactly what made webchat tasks
    // "stop mid task": the client saw an error while the tab was mid-thought.
    while (Date.now() < hardCap) {
        try {
            const tee = await readStreamedAnswer(teeStart);
            if (tee.found && tee.text.trim().length > 0) {
                console.log('⏱ timeout — rescuing the answer from the stream tee');
                return tee.text;
            }
            const last = await snapshotChat();
            // 08-13: never rescue while a generation is still running — the
            // newest row may be a stale previous answer or a stream fragment
            // (observed: the 20197-char gemini request rescued a 22-char row).
            const busyNow = state.mode === 'vl' ? await isGenerating() : await isForeignBusy();
            if (busyNow) {
                console.log('⏱ still generating past the deadline — extending (bounded by hard cap)');
                await sleep(1500);
                continue;
            }
            const ans = (last.answer || '').trim();
            if (ans.length > 0 && ans !== '…' && !/^\.{2,4}$/.test(ans) && !/^You have access to the tools below/.test(ans)) {
                console.log('⏱ timeout — rescuing the answer already on the tab');
                return last.answer;
            }
            break; // idle and no answer — give up below
        } catch {
            await sleep(1500);
        }
    }
    throw new Error(`Timed out after ${config.timeout}ms waiting for a response`);
}

// ──────────────────────────────────────────────────────
// 4b. CONTEXT HANDOFF (08-13): fresh chat + seed message
// ──────────────────────────────────────────────────────
// The thread's context window is exhausted → the gateway asks the webchat
// model for a handoff document, then navigates THIS tab to a brand-new chat
// (threads are server-side: the old conversation survives untouched) and
// sends the document as the first message. Typing on the new-chat page is
// what CREATES the thread; the tab's URL then carries the new /s/ id, which
// server.js captures and pins for every respawn path.
async function openNewChat() {
    // Fresh CDP session like every send (stale-session refresh).
    await initBrowser({ reconnect: true });
    // Re-pick the pinned tab (the old thread's tab gets navigated away — the
    // conversation stays safe server-side).
    if (!page && config.cdpWsUrl) {
        const pages = await browser.pages();
        page = config.tabUrlSubstring
            ? pages.find((p) => p.url().includes(config.tabUrlSubstring))
            : pages.find((p) => p.url().startsWith(new URL(config.webchatUrl).origin));
        if (!page) {
            page = await browser.newPage();
            await page.goto(config.webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
    }
    if (!page) page = await browser.newPage();
    console.log('🆕 Opening a NEW chat');
    // 08-13 MULTI-SITE: deepseek's "new chat" is the /a/chat root; other
    // webchats (qwen/kimi/gemini) don't have that — their root IS a new chat.
    // 08-15 (OWNER CORRECTION): the Instant/Expert/Vision mode tabs (radiogroup
    // b0db7355) render ONLY on /a/chat/new — the /a/chat LIST page has just the
    // DeepThink/Search toggles, so selectExpertMode found no tabs there and
    // every swap created an INSTANT thread (Search option present = not expert,
    // owner rule) → perpetual swap churn. Navigate to /a/chat/new instead.
    const newChatUrl = new URL(config.webchatUrl).host.includes('deepseek')
        ? 'https://chat.deepseek.com/a/chat/new'
        : config.webchatUrl;
    await page.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForChatInput();
    await sleep(2500); // let the SPA settle the composer
    // 08-14 (user rule): mode is locked at thread creation — select EXPERT
    // on the fresh new-chat composer BEFORE the first message creates the
    // thread (instant threads can never become expert afterwards).
    if (new URL(config.webchatUrl).host.includes('deepseek')) {
        await selectExpertMode();
        await sleep(500);
    }
    return page;
}

// Send the handoff document as the FIRST message of the fresh chat — plain
// text, NO tool-format preamble: the new thread must start with the document.
async function sendFirstMessage(text) {
    await typePrompt(text);
    const before = await snapshotChat();
    await sendMessage(null, text);
    console.log('⏳ Waiting for the new chat to acknowledge the handoff...');
    let reply = '';
    try {
        reply = await waitForResponse(before, text);
    } catch (e) {
        // The thread exists the moment the message lands; a timed-out first
        // reply (long cogitation) must not abort the swap.
        console.log('⚠️ new-chat first reply timed out:', String(e.message).slice(0, 80));
    }
    const url = page.url();
    if (!/\/a\/chat\/s\//.test(url)) {
        throw new Error(`New chat did not get a thread URL (still: ${url})`);
    }
    console.log(`🆕 New thread created: ${url}`);
    await saveCookies();
    return { url, reply };
}

async function openNewChatAndSeed(text) {
    await openNewChat();
    return sendFirstMessage(text);
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
    buildFullPrompt,
    openNewChat,
    sendFirstMessage,
    openNewChatAndSeed,
    getReqBodyChars,
    getAndClearThinkBuf,
    resetTeeForHandoff,
    takeThreadSwap,
};
