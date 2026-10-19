const fs = require('fs');
const puppeteer = require('puppeteer');
const config = require('./config');

// 08-14 WEDGE ROOT-CAUSE guard: nothing legitimate is ever near this; it
// exists to turn a runaway tool result into a loud client-visible error
// instead of a silent gateway wedge (see sendPrompt).
const MAX_PROMPT_CHARS = parseInt(process.env.MAX_PROMPT_CHARS || '900000', 10);

let browser = null;
let page = null;
let context = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 08-17 INSTANT SWAP (user rule: deepseek webchat runs in INSTANT mode with
// DeepThink + Search ON — mode is locked at thread creation, so an EXPERT
// thread must be swapped to a fresh instant chat). sendPrompt records the
// fresh thread here when the swap fired; server.js consumes it via
// takeThreadSwap() and pins respawns, the same way a context-handoff pins its
// new thread.
let swappingToInstant = false;
// 08-28: the FORCE_EXPERT swap (added 08-25) opened a fresh EXPERT chat but was
// never wired into the pin-capture below — only swappingToInstant armed it. So
// takeThreadSwap() always returned null for expert swaps, config.tabUrlSubstring
// kept pointing at the OLD instant thread, and EVERY send re-swapped: 666 swaps
// / 0 pins / 82 leaked tabs in 6h. Mirror flag so expert swaps pin too.
let swappingToExpert = false;
let threadSwapSeen = null;
// 08-17 TEE-START RACE FIX: waitForResponse filters tee entries to "this
// request" by seq > teeStart. Capturing teeStart at waitForResponse entry is
// TOO LATE when deepseek answers FAST — the completion XHR already pushed its
// entry (seq == teeStart), so the filter excludes the only entry and the wait
// hangs on the frozen DOM. Capture the seq right after the tee is armed, BEFORE
// the send; the completion then always pushes seq > teeStart. Set by
// sendMessage, consumed one-shot by waitForResponse.
let requestTeeStart = null;
// 08-24 (webchat transport audit): gemini generation-error banner-heal latch —
// true after one in-request heal reload so the same banner can't reload-hammer.
// This was previously UNDECLARED: the first read on the gemini lane threw a
// silent ReferenceError (request died with a confusing 500), and once the
// implicit global existed it NEVER reset, so every later real banner skipped
// the inline heal and the client retry landed on the same dirty tab.
// Reset in openNewChat(): a fresh chat is a clean slate.
let generationErrHealed = false;
// 08-24 (investigator 1, transport audit): gemini phantom-stop stability
// counter — counts consecutive waitForResponse polls where the newest row's
// text is byte-identical. Streaming rows grow every poll, so a counter >= 6
// (~9s) endorses a committed reply even while the ghost "Stop response"
// control keeps isForeignBusy() true (see the accept gate in waitForResponse).
let geminiStablePolls = 0;
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
        // 2026-08-19 (OOM fix): in LAUNCH mode (no cdpWsUrl) the browser is
        // OURS — disconnect() only detaches and LEAKS the whole chrome
        // process; close() kills it so the relaunch below doesn't stack a
        // second chrome (~2GB with renderers). In CDP mode we only attached
        // to the user's chrome — detach, never close.
        // 08-19 (gemini lane): sendPrompt refreshes BEFORE EVERY round, so
        // this used to tear the whole browser down per round — re-login,
        // re-cookies, fresh tab, ~10-20s wasted each, tab state lost. A
        // HEALTHY own browser survives the round loop untouched; only a
        // dead page/socket gets rebuilt.
        if (!config.cdpWsUrl && browser.isConnected() && page && !page.isClosed()) {
            console.log('🟢 Own browser healthy — reusing across rounds.');
            return;
        }
        try {
            if (config.cdpWsUrl) await browser.disconnect();
            else await browser.close();
        } catch {}
        browser = null;
        page = null;
        console.log(config.cdpWsUrl
            ? '🔌 Reconnecting CDP session (stale session refresh).'
            : '🧹 Closed own browser (stale) — relaunching fresh.');
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
            protocolTimeout: 240000, // tab can cogitate for minutes before answering
        });
        console.log('✅ Attached to existing browser.');
        return;
    }

    console.log('🚀 Launching browser...');
    if (process.env.CLOAKBROWSER === '1') {
        // CloakBrowser (08-21): stealth Chromium v146 — 73 source-level
        // fingerprint patches. Vanilla puppeteer's fake UA (Chrome/120 on the
        // real 151 binary) + ephemeral profile + saved cookies = Google session
        // rotation challenge → wedge. Cloak passes with the SAME cookies
        // (probe scripts/cloak_probe.js VERIFIED: SPA loaded, hasInput).
        // 08-24 audit fix (P1): cloak launch() IGNORES userDataDir (it is a
        // non-persistent launch) — the pinned login profile was never used.
        // launchPersistentContext honors it AND arrives with a page open;
        // never create a second incognito context on top.
        const { launchPersistentContext } = await import('cloakbrowser');
        context = await launchPersistentContext({
            headless: true,
            humanize: true,
            // Pinned profile when WEBCHAT_PROFILE is set; else a fresh
            // ephemeral dir (launchPersistentContext REQUIRES a string path).
            userDataDir: process.env.WEBCHAT_PROFILE
                || require('fs').mkdtempSync(require('os').tmpdir() + '/cloak-lane-'),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        browser = context.browser();
        page = context.pages()[0] || await context.newPage();
        // playwright → puppeteer API shims for the call sites below
        page.setUserAgent = async () => {};                       // cloak owns its UA
        page.setCookie = async (...cookies) => context.addCookies(
            cookies.map((c) => ({
                name: c.name, value: c.value, domain: c.domain, path: c.path,
                expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
                sameSite: c.sameSite,
            })).filter((c) => c.name && c.domain));
        page.cookies = async () => context.cookies();
        page.createCDPSession = async () => context.newCDPSession(page);
        // puppeteer's evaluate takes spread args (fn, a, b); playwright takes
        // exactly one (fn, arg). Repack multi-arg calls into a single spread —
        // covers all 17 multi-arg sites without touching them.
        const origEvaluate = page.evaluate.bind(page);
        page.evaluate = async (fn, ...args) =>
            args.length <= 1
                ? origEvaluate(fn, args[0])
                // closures don't survive serialization — rebuild the page
                // function self-contained from fn's source
                : origEvaluate(new Function('packed', `return (${fn.toString()})(...packed);`), args);
        console.log('✅ CloakBrowser ready.');
        return;
    }
    browser = await puppeteer.launch({
        // 08-19: system Chrome (151) only supports new headless; puppeteer's
        // bundled 121 shell freezes on modern SPAs. CHROME_PATH → new headless.
        headless: config.chromePath ? 'new' : config.headless,
        executablePath: config.chromePath || undefined,
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
        if (!Array.isArray(cookies)) return [];
        // 08-28 fix (Chrome 151 CDP): context.cookies() returns partitionKey /
        // sourcePort / sourceScheme on saved cookies; re-setting them makes CDP
        // Network.setCookie/deleteCookies fail with "partitionKey - CBOR: map
        // start expected" protocol errors. Drop the storage-partition fields.
        return cookies.map((c) => {
            const o = { ...c };
            delete o.partitionKey;
            delete o.sourcePort;
            delete o.sourceScheme;
            return o;
        });
    } catch {
        return [];
    }
}

async function saveCookies() {
    try {
        if (!page) return;
        const cookies = await page.cookies();
        // 08-24 audit fix (P3): save ONLY this lane's domain slice (the old
        // union save let the gemini lane re-cement the deepseek lane's dead
        // session) and write atomically (a kill mid-write truncated the file,
        // silently killing every login).
        const host = new URL(config.webchatUrl).host;
        const mine = cookies.filter((c) => {
            const d = (c.domain || '').replace(/^\./, '');
            return host.endsWith(d) || d.endsWith(host.split('.').slice(-2).join('.'));
        });
        const tmp = config.cookieFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(mine, null, 2));
        fs.renameSync(tmp, config.cookieFile);
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
            // 08-30 (fix, DS fresh-chat bug): after a CDP reconnect, `page` is
            // null and the pick below used to grab the FIRST origin-match —
            // which, once the driver holds several tabs, was the OLD conversation
            // tab (/a/chat/s/<uuid>). Every send then typed into the previous
            // persona's thread (personas shared b824ba98…-186f48365be9). A
            // fresh-chat tab sits at the ROOT (/a/chat or /a/chat/new) — prefer
            // those; only fall back to an existing thread tab if nothing else.
            const origin = new URL(webchatUrl).origin;
            const isThreadTab = (p) => /\/a\/chat\/s\//.test(p.url());
            page =
                pages.find((p) => !isThreadTab(p) && p.url().startsWith(origin)) ||
                pages.find((p) => p.url().startsWith(origin)) ||
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

    const cur = (page.url() || '').toString();
    if (!cur || cur === 'about:blank' || !cur.startsWith(new URL(webchatUrl).origin)) {
        // 08-24 audit fix (P4): a tab parked on a login/interstitial page
        // must be re-navigated, or we burn the full 300s on the wrong page.
        console.log(`🌐 On ${cur || 'about:blank'} — navigating to webchat`);
        await page.goto(webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
        console.log(`🟢 Already on page: ${cur}`);
    }

    await waitForChatInput(page);
    await saveCookies();
    return page;
}

// Login gate: the chat input's presence means the session is logged in.
// 08-24 audit fix (P5): nav-destroyed polls no longer crash the loop,
// interstitials trigger one reload, and any challenge cookies issued by the
// site are saved even on the timeout path.
async function waitForChatInput() {
    const deadline = Date.now() + config.loginWaitMs;
    let reloaded = false;
    while (Date.now() < deadline) {
        let el = null;
        try {
            el = await firstMatch(config.selectors.input);
        } catch {
            await sleep(3000); // navigation destroyed the execution context — keep polling
            continue;
        }
        if (el) {
            console.log('✅ Chat input found — logged in.');
            return;
        }
        const u = page.url() || '';
        if (!reloaded && /accounts\.google\.com|ServiceLogin|sorry|recaptcha|signin|passport/i.test(u)) {
            console.log('⚠️ login interstitial — reloading once');
            try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch {}
            reloaded = true;
        }
        console.log('🟡 Waiting for login — log into the browser window if prompted...');
        await sleep(3000);
    }
    await saveCookies(); // persist any challenge/rotation cookies just issued
    throw new Error(
        `Login wait timed out after ${config.loginWaitMs / 1000}s — no chat input found. ` +
        'Log in manually, then POST /connect.'
    );
}

// ──────────────────────────────────────────────────────
// 4. SEND PROMPT + GET RESPONSE
// ──────────────────────────────────────────────────────
async function sendPrompt(prompt, toolDefinitions) {
    // 09-04 MIN_LANE_GAP (ds-gw): the DeepSeek webchat account rate-limits
    // bursts ("Messages too frequent") — fires after ~5-8 messages in a few
    // minutes. Gate EVERY physical send (covers the internal tool-loop turns
    // too, which skip the request-level gate in handleRequest).
    if (process.env.MIN_LANE_GAP_SECONDS) {
        const gap = (Number(process.env.MIN_LANE_GAP_SECONDS) || 0) * 1000;
        const wait = (global.__lastPhysicalSend || 0) + gap - Date.now();
        if (wait > 0) await sleep(wait);
        global.__lastPhysicalSend = Date.now();
    }
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
    // 08-17 (user rule): the deepseek webchat runs in INSTANT mode with
    // DeepThink + Search ON. An EXPERT thread (no Search chip) cannot be
    // switched in place — swap to a fresh INSTANT chat; the in-flight prompt
    // becomes its first message. INSTANT_SWAP_EXPERT=1 gates this to the
    // instances that want it (8080 — the telegram responder's thread must
    // never be silently swapped).
    // 08-28 MUTUAL EXCLUSION: this branch and the FORCE_EXPERT branch below are
    // mirror-opposites (EXPERT->fresh INSTANT vs INSTANT->fresh EXPERT). The
    // 8080 unit sets BOTH flags, so once the expert pin starts persisting
    // (fixed today) these two would ping-pong the thread on every send — a
    // worse leak than the one being fixed. FORCE_EXPERT wins when both are set.
    // Not fixed by flipping the unit env: 8080 is SHARED (audit engine +
    // telegram_auto_responder + lane_watcher + cross_eval), so the env is not
    // the engine's to own.
    if (
        process.env.INSTANT_SWAP_EXPERT === '1' &&
        process.env.FORCE_EXPERT !== '1' &&
        new URL(config.webchatUrl).host.includes('deepseek') &&
        !(await isInstantThread())
    ) {
        console.log('🧪 pinned thread is EXPERT — swapping to a fresh INSTANT chat');
        swappingToInstant = true;
        await openNewChat();
    }
    // 08-25 (owner, NUCLEAR sweep): FORCE_EXPERT=1 — mirror-swap an INSTANT
    // pinned thread to a fresh EXPERT chat (expert = DeepThink chip only, no
    // Search). Same env-gated pattern as above; other gateways unaffected.
    if (
        process.env.FORCE_EXPERT === '1' &&
        new URL(config.webchatUrl).host.includes('deepseek') &&
        (await isInstantThread())
    ) {
        console.log('🧪 pinned thread is INSTANT — swapping to a fresh EXPERT chat (FORCE_EXPERT=1)');
        swappingToExpert = true;   // 08-28: arm the pin capture (see below)
        await openNewChat();
        await selectExpertMode();
    }
    // 08-17: force DeepThink + Search ON for the deepseek tab (instant mode
    // has both chips). No-op for foreign webchats (no such chips) and never
    // throws.
    await ensureToggles();
    console.log(`📤 Sending prompt (${prompt.length} chars) — tab: ${page.url()}`);

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
            // 08-21 (wedge self-heal): a generation stuck for 60s is wedged,
            // not slow — the SSE stream died leaving the tab's "generating"
            // state. Reload the page once (clears the stuck React state), wait
            // for idle, and only then fail. Without this the caller retries
            // into the same wedged tab forever (~65s per throw).
            console.log('🔄 foreign tab still generating after 60s — reloading to clear the wedge');
            try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch (e) {
                console.log('⚠ reload failed:', String(e.message).slice(0, 60));
            }
            for (let w = 0; w < 30; w++) {
                if (!(await isForeignBusy())) break;
                await sleep(1000);
            }
            if (await isForeignBusy()) {
                throw new Error('webchat tab still generating from a previous request — retry after it finishes');
            }
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

    // 08-28 PIN CAPTURE MOVED PRE-WAIT: a fresh thread gets its /s/ id the
    // moment the first message is sent, but this capture used to sit AFTER
    // waitForResponse — so a slow/timed-out generation (the deepseek audit
    // lane times out at 600s) threw before the id was ever recorded, the pin
    // stayed on the old thread, and the next send swapped again. Capture as
    // soon as the id exists; the URL updates asynchronously, so poll briefly.
    if (swappingToInstant || swappingToExpert) {
        swappingToInstant = false;
        swappingToExpert = false;
        for (let i = 0; i < 20; i++) {          // ≤10s, well under any send budget
            const u = page.url();
            const m = u.match(/\/a\/chat\/s\/([0-9a-f-]+)/);
            if (m && m[1]) { threadSwapSeen = { url: u, id: m[1] }; break; }
            await sleep(500);
        }
        if (!threadSwapSeen) {
            console.warn('⚠ swap pin capture: no /s/ id after 10s — pin unchanged, next send may re-swap');
        }
    }

    console.log('⏳ Waiting for response...');
    let text = await waitForResponse(before, fullPrompt);
    // 09-04 GEMINI EXTENDED-THINKING HEAD GUARD: the first bubble is a short
    // "Analyzing the Prompt's Design" / "Thinking about..." headline while the
    // model actually thinks; grabbing it as the answer then blew up the
    // shannon agents with format-error re-spam. Treat short thinking-head
    // texts as not-yet-answered and keep waiting (≤ ~4 min).
    const thinkingHead = (t) => t && t.length < 80 && /analyzing|thinking|planning|reasoning about|reflect|brainstorm/i.test(t);
    if (config.thinkingHeadGuard !== false && thinkingHead(text)) {
        for (let i = 0; i < 24; i++) {
            await sleep(10000);
            const t2 = await waitForResponse(before, fullPrompt);
            if (!t2) continue;
            if (thinkingHead(t2)) continue;
            text = t2;
            break;
        }
    }
    console.log(`📥 Response received (${text.length} chars)`);

    // 08-17 INSTANT-SWAP PIN: capture now happens immediately after
    // sendMessage (above) so a timeout in waitForResponse cannot lose it.

    // 08-16 (user): the visible tab must show each tool call ONCE, clean —
    // collapse the model's raw tool-call reply to its 💬 line so only the
    // gateway's typed receipt shows the tool. Display-only: the model's real
    // context lives on the webchat server. Best-effort — a re-render may
    // restore the JSON until the next request re-collapses it.
    await collapseBigReplies();

    await saveCookies(); // keep the session fresh
    return text;
}

// 08-16 (user): the visible gemini tab must show tool calls ONCE and clean —
// no raw JSON envelope, no double rendering. The model's reply is two things
// stuck in one bubble: a 💬 narration line + the fenced JSON tool call. The
// gateway's typed receipt right below already shows the tool name + status,
// so collapse the model's reply to just its 💬 line (or a bare "→ tool" marker
// if the model skipped narration). The model's real context lives on the
// webchat server; editing the DOM here is display-only. Best-effort.
async function collapseBigReplies() {
    if (!config.modelName || !/gemini/i.test(config.modelName)) return;
    try {
        await page.evaluate(() => {
            const rows = document.querySelectorAll('model-response');
            if (!rows.length) return;
            const collapseRow = (row) => {
                const t = (row.innerText || row.textContent || '').trim();
                if (!/"tool"\s*:/.test(t)) return false;
                // The model's final answer IS a submit_answer tool call whose
                // "text" param is the reply the user reads — never collapse it.
                if (/"tool"\s*:\s*"submit_answer"/.test(t)) return false;
                const keep = t.split('\n').map(l => l.trim()).filter(l => l.includes('💬')).join(' ');
                const name = (t.match(/"tool"\s*:\s*"([^"]+)"/) || [])[1];
                const marker = keep || (name ? `→ ${name}` : '');
                if (marker && marker !== t) { row.textContent = marker; return true; }
                return false;
            };
            // Newest first so the just-captured reply is handled first; walk all
            // rows so a re-render that restored old JSON gets cleaned again.
            let changed = 0;
            for (let i = rows.length - 1; i >= 0; i--) {
                if (collapseRow(rows[i])) changed++;
            }
            if (changed) console.log(`collapsed ${changed} tool-call rows`);
            return;
        });
    } catch (e) {
        console.log('⚠ collapseBigReplies failed:', String(e.message).slice(0, 60));
    }
}

// 08-17 (user rule): the deepseek tab runs in INSTANT mode, which has BOTH the
// DeepThink and Search chips — force both ON so every prompt gets reasoning
// plus live search. Idempotent, every request (a reload or tab flip can reset
// the chips). Foreign webchats have no such chips — harmless no-op.
async function ensureToggles() {
    try {
        const expertDeepThink = process.env.EXPERT_DEEPTHINK === '1';
        const clicked = await page.evaluate((expertDeepThink) => {
            const flipped = [];
            const btns = [...document.querySelectorAll('.ds-toggle-button')];
            // 08-25 (owner, NUCLEAR): mode-native toggle logic. Thread mode
            // detector: an INSTANT composer has the Search chip; an EXPERT
            // one does not (DeepThink only). wantOn per thread mode —
            // instant: Search ON + DeepThink OFF (08-21 rule); expert:
            // DeepThink ON (+EXPERT_DEEPTHINK=1 also forces it on instant).
            const searchPresent = btns.some(
                (el) => (el.textContent || '').trim() === 'Search');
            for (const el of btns) {
                const label = (el.textContent || '').trim();
                if (label !== 'DeepThink' && label !== 'Search') continue;
                const wantOn = label === 'Search'
                    ? true
                    : (label === 'DeepThink' && (!searchPresent || expertDeepThink));
                if (el.getAttribute('aria-pressed') === String(wantOn)) continue;
                el.click();
                flipped.push(label + (wantOn ? ' ON' : ' OFF'));
            }
            return flipped;
        }, expertDeepThink);
        if (clicked && clicked.length) console.log('🧠 toggles enabled: ' + clicked.join(', '));
