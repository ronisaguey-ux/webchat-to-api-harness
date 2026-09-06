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
// puppeteer 23+ dropped Browser.isConnected() in favour of the `.connected`
// boolean; support both across the 18 -> 25 upgrade (09-05 audit fix).
const browserAlive = (b) => {
    if (!b) return false;
    if (typeof b.isConnected === 'function') return b.isConnected();
    return Boolean(b.connected);
};


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
        if (!config.cdpWsUrl && browserAlive(browser) && page && !page.isClosed()) {
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
    if (browser && browserAlive(browser)) {
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
async function sendPrompt(prompt, toolDefinitions, systemText) {
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
    // 09-05 PING-PONG FIX (lane D strand root cause): this block used to be able
    // to run openNewChat() TWICE per send — the FORCE_EXPERT branch opened a
    // fresh chat and selected EXPERT, then the FRESH_PER_SEND branch below
    // opened ANOTHER one, and openNewChat's tail unconditionally re-pinned
    // INSTANT. Net effect on the ds-gw lanes (FORCE_EXPERT=1 AND
    // FRESH_PER_SEND=1): ~11s of extra SPA navigation churn before EVERY
    // prompt, the requested EXPERT mode silently discarded, and the composer
    // typed into a tab that had just finished a second full remount — which is
    // exactly the window in which the Enter keypress dispatches but React never
    // commits the send (the "stranded composer" 500). One fresh chat per send,
    // opened directly in the mode we actually want.
    const isDeepseekTab = new URL(config.webchatUrl).host.includes('deepseek');
    const wantExpert = process.env.FORCE_EXPERT === '1' && isDeepseekTab;
    const freshPerSend = process.env.FRESH_PER_SEND === '1';
    let openedFreshChat = false;
    if (
        process.env.INSTANT_SWAP_EXPERT === '1' &&
        process.env.FORCE_EXPERT !== '1' &&
        isDeepseekTab &&
        !(await isInstantThread())
    ) {
        console.log('🧪 pinned thread is EXPERT — swapping to a fresh INSTANT chat');
        swappingToInstant = true;
        await openNewChat({ mode: 'instant' });
        openedFreshChat = true;
    }
    // 08-25 (owner, NUCLEAR sweep): FORCE_EXPERT=1 — mirror-swap an INSTANT
    // pinned thread to a fresh EXPERT chat (expert = DeepThink chip only, no
    // Search). Same env-gated pattern as above; other gateways unaffected.
    // 09-05: when FRESH_PER_SEND is also on, the fresh chat this send needs IS
    // the expert swap — do it once, here, instead of opening twice.
    if (wantExpert && (freshPerSend || (await isInstantThread()))) {
        console.log(freshPerSend
            ? '🧪 fresh EXPERT chat for this send (FORCE_EXPERT=1 + FRESH_PER_SEND=1)'
            : '🧪 pinned thread is INSTANT — swapping to a fresh EXPERT chat (FORCE_EXPERT=1)');
        swappingToExpert = true;   // 08-28: arm the pin capture (see below)
        await openNewChat({ mode: 'expert' });
        openedFreshChat = true;
    }
    // 09-05 (executor speed): FRESH_PER_SEND env (ds-gw unit, engine lane) —
    // every send gets its OWN fresh DS chat. The shared executor thread grew
    // 30+ exchanges deep and each turn crawled (4+ min before first tokens —
    // the model re-digests the whole thread). Fresh = each engine exchange is
    // the thread's FIRST message: fast turns + zero cross-step contamination.
    // Skipped when a swap branch above already opened the fresh chat.
    if (freshPerSend && !openedFreshChat) {
        console.log('🍃 FRESH_PER_SEND — opening a fresh chat for this send');
        await openNewChat({ mode: wantExpert ? 'expert' : 'instant' });
        openedFreshChat = true;
    }
    // 08-17: force DeepThink + Search ON for the deepseek tab (instant mode
    // has both chips). No-op for foreign webchats (no such chips) and never
    // throws.
    // 09-05: MOVED below the chat-opening block — it used to run BEFORE the
    // FRESH_PER_SEND navigation, i.e. it toggled the chips on a tab that was
    // then thrown away, leaving the tab we actually send in un-toggled.
    await ensureToggles();
    // 09-05: chip clicks re-render the composer. ensureToggles has no settle at
    // all, so control used to reach typePrompt while the SPA was still swapping
    // the composer subtree out. Wait for a genuinely interactive composer.
    await waitComposerReady();
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

    const fullPrompt = buildFullPrompt(prompt, toolDefinitions, systemText);

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
    } catch (e) {
        console.log('⚠ toggle ensure failed:', String(e.message).slice(0, 60));
    }
}

// 08-14 (user rule): instant mode = Search chip present, expert = DeepThink
// only. The chip set is the reliable mode detector — the mode itself is
// locked at thread creation and cannot be read from the URL.
// ── Composer-ready gate (09-05, lane-D strand fix) ───────────────────────
// Mode-radio and toggle-chip clicks REMOUNT the composer subtree. Typing (or
// pressing Enter) into a composer React is still mounting is the mechanism
// behind the "stranded prompt": the keystrokes land in a DOM node that is then
// replaced, so the text is visible but the send never commits. The old code
// covered this with blind sleeps (900ms in selectInstantMode, 2500+500ms in
// openNewChat) and NOTHING at all after ensureToggles' click loop.
//
// This is a real check, not a sleep. The composer must be present, rendered,
// enabled, and carry a React fiber/props key (React has mounted AND claimed the
// node), the send control must exist — and all of that must hold for the SAME
// live element instance across three consecutive polls, so a remount in flight
// is caught instead of typed into. Returns as soon as it is satisfied (~0.5s on
// a settled tab), so it is cheaper than the sleeps it backstops.
//
// It also brings the tab to the front. Four DeepSeek SPAs share one headless
// Chrome and nothing in this file ever called bringToFront, so three of them
// sat at visibilityState:'hidden' with throttled timers/rAF — which is exactly
// the load correlation the strand shows.
async function waitComposerReady(timeoutMs = 15000) {
    try { await page.bringToFront(); } catch { /* detached / single-target browser */ }
    // The React-fiber requirement is DeepSeek-specific: gemini/qwen/kimi are not
    // React apps, so demanding a fiber key there would stall this gate for its
    // whole budget on every send. Those sites still get the mount/visible/
    // enabled/stable-instance checks.
    const needReactKey = new URL(config.webchatUrl).host.includes('deepseek');
    const deadline = Date.now() + timeoutMs;
    let lastMark = null;
    let stable = 0;
    while (Date.now() < deadline) {
        let s = null;
        try {
            s = await page.evaluate((sels, sendSels, needReactKey) => {
                let el = null;
                for (const sel of sels) { el = document.querySelector(sel); if (el) break; }
                if (!el) return null;
                if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
                if (!el.getClientRects().length) return null;          // not rendered yet
                const keyed = Object.keys(el).some(
                    (k) => k.startsWith('__reactProps$') || k.startsWith('__reactFiber$'));
                if (needReactKey && !keyed) return null;                // React hasn't claimed it
                // Stamp the live node: a remount between polls yields a fresh
                // node with no stamp, so the mark changes and stability resets.
                if (!el.dataset.wsReadyMark) {
                    el.dataset.wsReadyMark = String(Date.now()) + '-' + String(Math.random()).slice(2, 8);
                }
                let send = false;
                for (const sel of sendSels) { if (document.querySelector(sel)) { send = true; break; } }
                return { mark: el.dataset.wsReadyMark, send };
            }, config.selectors.input, config.selectors.send, needReactKey);
        } catch { s = null; }
        if (s && s.send && s.mark === lastMark) {
            stable += 1;
            if (stable >= 2) return true;      // same live node, ready, 3 polls running
        } else {
            stable = 0;
        }
        lastMark = s ? s.mark : null;
        await sleep(250);
    }
    console.log('⚠ composer-ready gate timed out — proceeding anyway');
    return false;
}

async function isInstantThread() {
    try {
        return await page.evaluate(() =>
            [...document.querySelectorAll('.ds-toggle-button')].some(
                (el) => (el.textContent || '').trim() === 'Search'));
    } catch {
        return false; // fail-open: a DOM hiccup must never block a send
    }
}

// 08-17 (user rule): select INSTANT mode on a fresh new-chat page. Mode is
// locked at thread creation, so this works ONLY on the new-chat composer.
// 08-15 (USER CORRECTION): the Instant/Expert/Vision tabs were NEVER removed —
// they are a radiogroup (div.b0db7355, role="radio" options; dfb78875 = the
// unselected option's inner div, aa40b5de + _31a22b0 on the selected radio).
// My earlier probe missed them because they are NOT <button>s. The instant
// check per owner rule: an instant composer HAS a Search option — "if u see a
// search option that means its not expert". So select = click the Instant
// radio at creation, then VERIFY Search IS present (else it's expert).
// Never throws — a UI change just logs and continues rather than stalling.
async function selectInstantMode() {
    try {
        const flipped = await page.evaluate(() => {
            const out = [];
            const radios = [...document.querySelectorAll('[role="radiogroup"] [role="radio"]')];
            const instant = radios.find((r) => /instant/i.test(r.textContent || ''));
            if (!instant) {
                out.push('NO_MODE_TABS');
            } else {
                const isSel = instant.getAttribute('aria-checked') === 'true'
                    || (instant.className || '').includes('_31a22b0');
                if (!isSel) { instant.click(); out.push('Instant tab'); }
            }
            for (const el of document.querySelectorAll('.ds-toggle-button')) {
                const label = (el.textContent || '').trim();
                if (label === 'DeepThink' && el.getAttribute('aria-pressed') === 'true') { el.click(); out.push('DeepThink OFF'); }
                if (label === 'Search' && el.getAttribute('aria-pressed') !== 'true') { el.click(); out.push('Search ON'); }
            }
            return out;
        });
        await sleep(900); // composer re-renders for the selected mode
        const searchPresent = await page.evaluate(() =>
            [...document.querySelectorAll('.ds-toggle-button')].some(
                (el) => (el.textContent || '').trim() === 'Search'));
        if (!searchPresent) {
            console.log('⚠ instant select FAILED — Search option absent (thread is EXPERT, not instant)');
        } else {
            console.log(flipped && flipped.length
                ? '🧠 new chat set to INSTANT mode (' + flipped.join(', ') + ') — Search present, verified'
                : '🧠 already instant (Search option present, DeepThink on)');
        }
    } catch (e) {
        console.log('⚠ selectInstantMode failed:', String(e.message).slice(0, 60));
    }
}

// 08-25 (owner, NUCLEAR): mirror of selectInstantMode — click the EXPERT mode
// radio on the fresh-chat composer and DeepThink ON (expert has no Search
// chip). Mode is locked at thread creation, so this only works on a new chat.
async function selectExpertMode() {
    try {
        if (await isInstantThread()) {
            console.log('⚠ expert select: composer still shows a Search chip (mode tabs missed?)');
        }
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
        await sleep(900);
        const searchPresent = await page.evaluate(() =>
            [...document.querySelectorAll('.ds-toggle-button')].some(
                (el) => (el.textContent || '').trim() === 'Search'));
        if (searchPresent) {
            console.log('⚠ expert select FAILED — Search chip still present (thread is INSTANT, not expert)');
        } else {
            console.log(flipped && flipped.length
                ? '🧠 new chat set to EXPERT mode (' + flipped.join(', ') + ') — Search absent, verified'
                : '🧠 already expert (no Search chip)');
        }
    } catch (e) {
        console.log('⚠ selectExpertMode failed:', String(e.message).slice(0, 60));
    }
}

// ── Type into the chat input ──
// Prefer the React-safe native-setter path (fast, works on textareas);
// contenteditable editors (Gemini, …) fall back to the hybrid path below.
// ⚠️ keyboard.type() translates "\n" into Enter keypresses (partial send),
// so newlines are never typed — they ride insertText instead.
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

    // 08-17 DEEPSEEK REACT-SYNC: the native-setter path populates the textarea
    // DOM but deepseek's React model can desync from it — sends then carry a
    // STALE value (verified 08-17: composer showed the typed text, the thread
    // recorded an old string; the completion XHR carried the old prompt). Real
    // key events wake the React model (probed live: keyboard-typed prompts hit
    // the completion body verbatim). Force the hybrid path for deepseek too;
    // other sites keep the fast native-setter path.
    const deepseek = new URL(config.webchatUrl).host.includes('deepseek');
    if (set && !deepseek) return;

    // contenteditable (gemini Quill/Angular) + deepseek (React-sync): HYBRID
    // input.
    // 08-16: bulk Input.insertText alone NEVER arms the editor — text lands in
    // the DOM but the app's model stays empty, so Enter/send no-op ("stranded in
    // composer"; observed on both 9224 and the GUI tab). REAL key events wake
    // the editor and build the model; the tail then rides a fast insertText.
    // Newlines through keyboard.type would be Enter keypresses (partial send),
    // so they always go through insertText. Arm + clear FIRST so the Ctrl+A
    // Backspace actually clears stale stranded text (it no-ops on a cold editor).
    await page.evaluate((sels) => {
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); return; }
        }
    }, config.selectors.input);
    await sleep(400);
    await page.keyboard.type(' ');
    await sleep(150);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    const cdp = await page.createCDPSession();
    const WAKE = 120;
    // 08-17: batch insertText into large chunks instead of one round-trip per
    // line. A huge prompt (helpotron ~224k chars / thousands of lines) was
    // burning one CDP Input.insertText per line → ~thousands of round-trips →
    // blew the 300s gateway timeout mid-insert, so the prompt never submitted.
    const CHUNK = 8192;  // chars per insertText; flush only between lines so
                         // segments/surrogate pairs are never split mid-string
    const parts = text.split('\n');
    let typed = 0;
    let buf = '';
    const flush = async () => { if (buf) { await cdp.send('Input.insertText', { text: buf }); buf = ''; } };
    for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (seg) {
            if (typed < WAKE) {
                const take = Math.min(seg.length, WAKE - typed);
                await page.keyboard.type(seg.slice(0, take));
                typed += take;
                if (take < seg.length) buf += seg.slice(take);
            } else {
                buf += seg;
            }
        }
        if (i < parts.length - 1) buf += '\n';
        if (buf.length >= CHUNK) await flush();
    }
    await flush();
    await cdp.detach();
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
    // 08-17 TEE-START RACE FIX: snapshot the tee seq AFTER the install (which
    // may init the buffer on a fresh page) but BEFORE any send — the fast-reply
    // race otherwise hides the completion (see requestTeeStart above).
    requestTeeStart = await page.evaluate(() => (window.__wsTeeSeq || 0)).catch(() => 0);
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
                    if (process.env.SKIP_CLEAR_VERIFY !== '1') return verifySendCleared(text);
                }
                await page.keyboard.press('Enter');
            }
            if (process.env.SKIP_CLEAR_VERIFY !== '1') return verifySendCleared(text);
        } catch (e) {
            const stale = /not clickable|not an Element|detached|context destroyed/i.test(e.message);
            if (!stale || attempt >= 2) throw e;
            console.log(`🔄 send flow hit a stale handle — re-typing (attempt ${attempt + 2})`);
            await sleep(1500);
            input = await typePrompt(text);
        }
    }
}

// 08-16 SEND-VERIFY: an Enter press or send-button click can silently no-op
// when React's composer state is out of sync with the DOM (stranded text —
// the DOM shows the prompt, React thinks the composer is empty; observed on
// gemini after a CDP session reconnect, 7678-char prompt). Before, sendMessage
// returned straight into waitForResponse, which can't tell "still generating"
// from "never sent", and ground to the hard cap (25 min) for a message that
// isn't coming. Poll for the composer to clear; fail fast with a clear error
// if it doesn't — the client retries and the tab stays usable.
// 09-05 (lane-D strand fix): takes the TYPED TEXT, not just its length. The old
// verdict was "is ANY matched input non-empty" — it never checked that what sat
// in the composer was OUR prompt, so an unrelated non-empty input (or a stale
// contenteditable) read as a strand, and a genuinely stranded prompt was
// indistinguishable from one. composerHoldsPrompt() has been the correct
// discriminator all along; it just could not be reached because both call sites
// passed `text.length`.
async function verifySendCleared(typedText = '') {
    const promptLen = String(typedText || '').length;
    // 09-05: the old `promptLen > 20000 ? 45 : 10` gave sub-20k prompts a flat
    // 10s. Observed strands include 440- and 462-char prompts, and the SAME
    // 5551-char prompt stranded twice then committed unchanged on the third
    // try — size is not the discriminator, so the small tier was simply too
    // tight under the global send mutex. 20s for small, 45s for bulk.
    const polls = promptLen > 20000 ? 45 : 20;
    if (await waitComposerCleared(typedText, polls)) return;
    // 08-17/08-23 stranded-composer flow (shared with waitForResponse since
    // 09-04) — now recovers the send instead of only reloading + throwing.
    await healStrandedComposer(typedText);
}

// Poll until the composer no longer holds `typedText` (i.e. the send committed).
// Split out of verifySendCleared so the heal path can re-verify a replayed send
// WITHOUT re-entering the heal. Falls back to the legacy "any input empty" test
// when no text is available (the gemini waitForResponse call site).
async function waitComposerCleared(typedText, polls) {
    const haveProbe = String(typedText || '').trim().length > 0;
    for (let i = 0; i < polls; i++) {
        await sleep(1000);
        if (haveProbe) {
            if (!(await composerHoldsPrompt(typedText))) return true;
            continue;
        }
        const empty = await page.evaluate((sels) => {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (!el) continue;
                const v = el.value !== undefined ? el.value : el.innerText || '';
                if (v.trim().length > 0) return false;
            }
            return true;
        }, config.selectors.input).catch(() => false);
        if (empty) return true;
    }
    return false;
}

// Re-commit a prompt that is sitting in the composer: focus, Enter, and — only
// if Enter did not take — the send button (SEND-glyph guarded, never STOP).
// Returns true when the composer no longer holds the text.
async function recommitSend(typedText) {
    try {
        await page.evaluate((sels) => {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); return true; }
            }
            return false;
        }, config.selectors.input);
        await sleep(400);
        await page.keyboard.press('Enter');
        await sleep(1500);
        if (!(await composerHoldsPrompt(typedText))) return true;   // Enter took
        const btn = await page.evaluate((sels) => {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                const d = ((el.querySelector('svg path') || { getAttribute: () => '' }).getAttribute('d') || '');
                el.scrollIntoView({ block: 'center' });
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, glyph: d.slice(0, 8) };
            }
            return null;
        }, config.selectors.send);
        if (!btn) return false;
        // Same STOP-morph guard as sendMessage: never click a button that is in
        // STOP state — it would kill a live generation.
        const isDeepseek = new URL(config.webchatUrl).host.includes('deepseek');
        if (isDeepseek && !btn.glyph.startsWith('M8.3125')) {
            console.log('🛑 re-commit skipped — send button is in STOP state');
            return false;
        }
        await sleep(300);
        const pos = await page.evaluate((sels) => {
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
            return null;
        }, config.selectors.send);
        if (!pos) return false;
        await page.mouse.click(pos.x, pos.y);
        return true;
    } catch (e) {
        console.log('⚠ re-commit send failed:', String(e.message).slice(0, 80));
        return false;
    }
}

// ── Stranded-composer heal (08-17/08-23 flow, shared since 09-04) ─────────
// Called once the composer provably still holds the prompt — i.e. the send
// never COMMITTED (React out of sync OR the backend rejected it). Surface
// the REAL cause when gemini's backend rejected the send (BardErrorInfo
// 1095/1096 = rate-limit/abuse block, NOT a React-state bug; reloading
// doesn't help, waiting out the cooldown does). Otherwise auto-heal: the
// tab's React state is gone, so reload it INLINE — the client's retry
// (attempt 2/2) then lands on a fresh tab instead of a second guaranteed
// failure. ALWAYS throws (bard-rejection error OR the strand error).
// 09-05 (lane-D fix): this used to reload the tab and then ALWAYS throw, which
// turned a transient, self-correcting timing race into a hard HTTP 500 for the
// engine — one strand cost a whole batch (lane hop + cooldown). Evidence: the
// identical 5551-char prompt stranded twice and then committed unchanged on the
// third attempt, and 521 composer samples across three strand windows showed
// DOM == React == _valueTracker with the send button in SEND state, i.e. NO
// React desync at all. The send simply never committed. So recover it here:
//   1. re-commit in place (focus + Enter, then the SEND-glyph button) — no
//      reload, so an in-flight stream tee stays armed;
//   2. failing that, reload, restore the mode/toggles, RE-ARM the stream tee
//      (the reload destroys it, and the answer is read from the tee — not the
//      DOM — so replaying without re-arming would return an empty reply),
//      re-type and re-send.
// Only when both fail does it throw. `strandReplayDepth` keeps the replay from
// re-entering itself through verifySendCleared.
let strandReplayDepth = 0;

async function healStrandedComposer(typedText = '') {
    let bard = '';
    try { bard = await page.evaluate(() => window.__wsLastBardError || ''); } catch { /* ignore */ }
    if (bard) {
        throw new Error(`webchat send failed — gemini backend rejected the send (BardErrorInfo ${bard} = rate-limit/abuse block). Wait out the cooldown; do NOT reload-hammer it.`);
    }
    const probe = String(typedText || '');
    // No text to replay (the gemini waitForResponse call site) or already inside
    // a replay → keep the legacy behaviour: reload so the client's retry lands
    // on a clean tab, then throw.
    if (!probe.trim() || strandReplayDepth > 0) {
        console.log('🧹 stranded composer detected — reloading tab for inline self-heal');
        try {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(3000); // let the UI settle after reload
            const inputAvail = await page.evaluate((sels) => {
                for (const sel of sels) {
                    if (document.querySelector(sel)) return true;
                }
                return false;
            }, config.selectors.input);
            console.log(inputAvail
                ? '🧹 tab reloaded — composer input present, ready for client retry'
                : '🧹 tab reloaded but composer input not found — client retry may still fail');
        } catch (e) {
            console.log('🧹 inline reload failed:', String(e.message).slice(0, 60));
        }
        throw new Error('webchat send failed — prompt stranded in composer. Tab reloaded; retry the send.');
    }

    strandReplayDepth += 1;
    try {
        // ── Attempt 1: in-place re-commit (no reload) ───────────────────────
        console.log('🧹 stranded composer — re-committing the prompt in place (no reload)');
        await waitComposerReady();
        if (await recommitSend(probe)) {
            if (await waitComposerCleared(probe, 20)) {
                console.log('✅ strand recovered — send committed on the in-place re-commit');
                return;
            }
        }
        // ── Attempt 2: reload, restore state, replay ────────────────────────
        console.log('🧹 in-place re-commit did not take — reloading tab and replaying the prompt');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForChatInput();
        await waitComposerReady();
        const isDeepseek = new URL(config.webchatUrl).host.includes('deepseek');
        // Mode is locked at thread creation, so only re-select it while the tab
        // is still on a NEW chat — never on an existing /a/chat/s/ thread.
        if (isDeepseek && !/\/a\/chat\/s\//.test(page.url())) {
            if (process.env.FORCE_EXPERT === '1') await selectExpertMode();
            else await selectInstantMode();
            await waitComposerReady();
        }
        await ensureToggles();
        await waitComposerReady();
        // The reload wiped the page-side stream tee. waitForResponse reads the
        // answer from it (window.__wsTeeSeq / readStreamedAnswer), and its
        // sequence snapshot was taken once at the top of sendMessage — before
        // this reload — so both must be re-established or the replayed answer
        // is invisible to the caller.
        await installStreamTee().catch(
            (e) => console.log('⚠ stream tee re-install failed:', String(e.message).slice(0, 60)));
        requestTeeStart = await page.evaluate(() => (window.__wsTeeSeq || 0)).catch(() => 0);
        await typePrompt(probe);
        if (await recommitSend(probe)) {
            if (await waitComposerCleared(probe, 30)) {
                console.log('✅ strand recovered — prompt replayed on the reloaded tab');
                return;
            }
        }
    } catch (e) {
        console.log('🧹 strand replay failed:', String(e.message).slice(0, 120));
    } finally {
        strandReplayDepth -= 1;
    }
    throw new Error('webchat send failed — prompt stranded in composer; in-place re-commit and reload+replay both failed. Retry the send.');
}

// ── Composer-holds-prompt probe (09-04) ─────────────────────────────────
// True when the composer still contains the ORIGINAL typed prompt (the send
// never committed). waitForResponse's extended empty-wait uses this to tell
// a STRANDED tab (needs the heal reload) from a merely SLOW one (keep
// waiting). Normalized whitespace so contenteditable line breaks don't hide
// a verbatim hold; returns false on any read failure (never a false heal).
async function composerHoldsPrompt(typedText) {
    const probe = String(typedText || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!probe) return false;
    try {
        return await page.evaluate((sels, probe) => {
            const norm = (s) => String(s || '').replace(/\s+/g, ' ');
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (!el) continue;
                const v = el.value !== undefined ? el.value : el.innerText || '';
                const t = norm(v).trim();
                if (t.length > 0 && t.includes(probe)) return true;
            }
            return false;
        }, config.selectors.input, probe);
    } catch {
        return false;
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
            }
        }
        let rawTxt = lastEl ? (lastEl.innerText || '').slice(0, 100000) : '';
        let txt = rawTxt
            .replace(/^\s*Gemini said\s*\n*/gi, '')
            .replace(/\bGemini said\b\s*/gi, '')
            .replace(/^\s*JSON\s*\n+/gi, '')
            .replace(/^\s*(?:json|txt|text|python|bash|shell)\s*(?:Copy\s*)?(?:Download\s*)?\n+/gi, '')
            .trim();
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
        // 08-17 GEMINI 1096 SURFACING: when gemini's backend REJECTS a send,
        // the composer stays populated and verifySendCleared misreports it as
        // "React out of sync". The rejection is a StreamGenerate XHR whose
        // body carries `BardErrorInfo [<code>]` (1095/1096 = rate-limit /
        // abuse block — wait it out; hammering extends it). Record the last
        // code so the send-failure path can report the real cause. Flag-guarded
        // and placed BEFORE the v2 guard so gateway restarts arm it on the
        // long-lived page without a reload (__wsUrl is set by the open-wrapper
        // below before send ever runs).
        if (!window.__wsBardErrArmed) {
            window.__wsBardErrArmed = true;
            const _gsSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (...args) {
                const x = this;
                if (x.__wsUrl && x.__wsUrl.includes('StreamGenerate')) {
                    x.addEventListener('loadend', () => {
                        try {
                            const t = String(x.responseText || '');
                            const m = t.match(/BardErrorInfo[^]]*\[(\d+)\]/);
                            if (m) window.__wsLastBardError = m[1];
                        } catch { /* non-fatal */ }
                    });
                }
                return _gsSend.apply(this, args);
            };
        }
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
function isGeminiWebchat() {
    return /gemini/i.test(config.webchatUrl) || /gemini/i.test(config.modelName || '');
}
async function waitForResponse(before, typedText) {
    // 08-13 SSE-TEE: the completion XHR's streamed body is now the primary
    // answer source (the DOM stopped rendering responses in this env). Tee
    // entries are pushed at loadend — anything at/after this index appeared
    // while WE poll, so it belongs to this request (the queue is serialized).
    // 08-13 CAP BUG FIX: track the tee by seq — length-based starts break once
    // eviction keeps length pinned at 32 (new entries were invisible forever).
    // 08-17 TEE-START RACE FIX: prefer the pre-send snapshot from sendMessage;
    // the entry-time capture here is too late for fast deepseek replies.
    const teeStart = requestTeeStart !== null
        ? requestTeeStart
        : await page.evaluate(() => (window.__wsTeeSeq || 0)).catch(() => 0);
    requestTeeStart = null; // consume the one-shot snapshot
    let deadline = Date.now() + config.timeout;
    // Absolute cap so a pathological never-ending stream can't hang the client
    // forever — activity may extend the deadline, but not past this.
    const hardCap = deadline + config.timeout; // 08-24 (latency audit): was timeout×5 — a 15-min timeout bought 90 min of phantom polling; one extra timeout is the sane ceiling
    let lastLen = -1; // forces at least two polls before accepting
    let lastAnswerLen = -1; // same for the think-stripped answer text (08-12)
    let lastText = null; // previous poll's thread text, for activity detection
    let emptySince = 0; // how long the newest message element has been empty
    // 09-04 (A3 resilience): the 12s empty verdict is NOT a hard fail on a
    // busy/slow tab — grant ONE longer re-check window first, and only heal/
    // throw after that. Bounded per call: one extension + one heal, never loops.
    let emptyBudget = 12000;    // first empty window; 25000 after the grace
    let emptyExtended = false;  // "⏳ slow reply" extension already granted
    let strandHealDone = false; // stranded-composer heal already attempted
    // 08-23 WEDGE FIX (investigator report): phantom-stop detector state.
    let busySilentSince = 0;      // busy-without-progress start, ms since epoch (0=armed)
    let lastProgressLen = 0;      // text+answer length at last poll (progress baseline)
    let lastSpinLog = 0;          // last [still waiting] spin-log timestamp
    let phantomRecovered = false; // fresh-chat recovery already fired for this request
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
            if (!browser || !browserAlive(browser) || page.isClosed()) {
                throw new Error('Webchat browser connection lost (Chrome crashed?) — please resend');
            }
            // Page busy (long cogitation / heavy render) — an evaluate can throw
            // ProtocolError mid-thought. That means "still generating", not failure:
            // keep polling until the deadline.
            console.log('⏳ poll evaluate failed (page busy?), retrying:', String(e.message).slice(0, 70));
            await sleep(1500);
            continue;
        }
        // 08-16 GEMINI API-ERROR BAIL: gemini renders a transient inline error
        // banner ("● API Error — The response stopped arriving", "Something
        // went wrong with this response") when a generation dies mid-stream.
        // The phantom-stop keeps busy=true, so without this the loop ground to
        // the hard cap (timeout×5, 25 min on the 300s gemini timeout) for a
        // reply that never arrives. Fail fast with a clear marker instead —
        // the client retries and the tab stays usable.
        // 08-24 USER-ROW GUARD (hoisted above the banner scan): until the model
        // answers, the newest rendered row IS our own prompt — and audit
        // digests routinely contain literal strings like "API Error" /
        // "Something went wrong", so the banner regex below self-matched the
        // just-typed 60k chunk → spurious heal reload (destroying the typed
        // prompt) + "generation stopped" 500 within seconds of every big send.
        const USER_ROW_CLS = '_9663006';
        // 08-13: newer rows hash to _81e7b5e (probed live) — the hash-only
        // check missed them, and the last row after a send is often the
        // gateway's own tool-preamble USER row, which the DOM path could
        // accept as the answer. Guard on hash OR the preamble prefix.
        // 08-24 echo probe: rendered markdown strips "###"/fences, so match a
        // long prose line from OUR OWN typed text verbatim — survives any
        // renderer transform and is site-agnostic.
        const echoProbe = (() => {
            for (const l of String(typedText || '').split('\n')) {
                if (l.trim().length > 60) return l.trim().slice(0, 120);
            }
            return null;
        })();
        const rowText = (state.answer || '') + ' ' + (state.text || '');
        const userRow = (state.lastCls || '').split(/\s+/).includes(USER_ROW_CLS)
            || (state.lastCls || '').split(/\s+/).includes('_81e7b5e')
            || /^You have access to the tools below/.test(state.answer || '')
            || (!!echoProbe && rowText.includes(echoProbe));
        if (isGeminiWebchat() && !generationErrHealed && !userRow && /API Error|response stopped arriving|went wrong with this response|response was not generated|wasn'?t generated|Something went wrong/i.test(rowText)) {
            generationErrHealed = true;
            console.log('🔄 gemini generation-error banner seen (newest assistant row) — reloading tab once, then throw so the client retries clean');
            try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch {}
            await sleep(2000);
            throw new Error('Gemini API error detected in tab (generation stopped) — resend the prompt');
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
        // userRow/USER_ROW_CLS hoisted above the gemini banner scan (08-24).
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
        } else if ((grew || state.text !== before.text) && state.text.length > 0 && state.text.length === lastLen) {
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
                if (!toolDone) {
                    // 08-24 (investigator 1, transport audit): plain-text gemini
                    // replies hit the SAME phantom-stop trap the toolDone branch
                    // was built for — the SPA commits the answer to the DOM but
                    // leaves an unclickable "Stop response" control up for
                    // minutes, so isForeignBusy() stays true and the gate only
                    // opens when the ghost finally clears. Observed as the 1348s
                    // (161 chars) and 594s (4849 chars) gemini stalls in the
                    // 08-24 audit log — a committed answer burned the whole
                    // deadline (+progress extensions) instead of ~10s. A
                    // non-truncated row unchanged across 6 consecutive polls
                    // (~9s) is a committed reply, not a mid-stream fragment
                    // (streaming grows the row every poll); accept it while
                    // busy. Gemini only — other sites' stop controls are
                    // trusted.
                    if (
                        isGemini && geminiStablePolls >= 6 &&
                        ctext.length > 0 && !looksLikeTruncatedAnswer(ctext)
                    ) {
                        console.log(`🤖 gemini answer stable ${geminiStablePolls} polls while stop control up — accepting committed reply`);
                        return ctext;
                    }
                    await sleep(1500);
                    continue;
                }
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
            if (emptySince > emptyBudget) {
                // 09-04 (A3 resilience): gemini's SPA is often just SLOW/busy —
                // the send commits, the tab shows the prompt, but the output
                // lands well past 12s. Before treating the empty row as a hard
                // fail, grant ONE longer re-check window (~25s more); a tab
                // that is merely busy answers inside it. Still empty after the
                // extension → decide between "stranded" and "stopped" below.
                if (!emptyExtended) {
                    emptyExtended = true;
                    emptySince = 0;
                    emptyBudget = 25000;
                    console.log('⏳ slow reply (busy tab) — extending wait');
                } else {
                    // Extended wait still returned nothing. If the composer
                    // still holds the ORIGINAL prompt text, the send never
                    // COMMITTED — that is a stranded composer, not a slow tab.
                    // Heal it with the same inline reload verifySendCleared
                    // uses (healStrandedComposer — bard-check + reload, always
                    // throws its strand error) ONCE per call, so the client's
                    // retry lands on the healed tab. Bounded: strandHealDone
                    // guarantees the reload happens at most once here.
                    if (isGeminiWebchat() && !strandHealDone && await composerHoldsPrompt(typedText)) {
                        strandHealDone = true;
                        await healStrandedComposer(); // reload then throw the strand error
                    }
                    throw new Error('Webchat response is empty after 12s — stopped or aborted by the UI');
                }
            }
        } else {
            emptySince = 0;
        }
        // 08-23 WEDGE FIX (investigator report #1+#3): deadline extension now
        // requires REAL progress (text/answer movement). The old bare-busy
        // extension let a phantom STOP (SSE dead with the stop button up)
        // extend the wait to the 6x hard cap with zero output — the silent
        // wedge. Genuine generation is still covered: DeepThink streams
        // reasoning text (progress ticks), and silent-but-real cogitations are
        // given an 8-min grace before recovery below.
        const progressLen = (state.text ? state.text.length : 0) + (state.answer ? state.answer.length : 0);
        const progressedNow = (state.mode === 'vl' && lastText !== null && state.text !== lastText)
            || progressLen !== lastProgressLen;
        if (progressedNow) {
            busySilentSince = 0;
            deadline = Math.min(hardCap, Math.max(deadline, Date.now() + config.timeout));
        } else if (busy) {
            // Phantom-stop detector (08-23): busy with zero progress. Stream a
            // [still waiting] spin line every 60s; after 8 min, open a FRESH
            // chat once (a server-side pending generation on the dead thread
            // is what keeps the account's one-in-flight rule locked — a new
            // thread escapes it); 60s after that, fail fast so the caller can
            // retry instead of spinning to the 6x hard cap.
            if (busySilentSince === 0) busySilentSince = Date.now();
            if (Date.now() - lastSpinLog > 60000) {
                lastSpinLog = Date.now();
                console.log(`[still waiting] busy text-len=${progressLen} silent=${Math.round((Date.now() - busySilentSince) / 1000)}s`);
            }
            if (!phantomRecovered && Date.now() - busySilentSince > 8 * 60000) {
                console.log('phantom STOP: busy without progress for 8 min — opening a fresh chat');
                phantomRecovered = true;
                busySilentSince = Date.now();
                try {
                    await openNewChat();
                } catch (e) {
                    console.log('fresh-chat recovery failed, falling back to reload:', String(e.message).slice(0, 60));
                    try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch (e2) { console.log('reload failed:', String(e2.message).slice(0, 60)); }
                }
            } else if (phantomRecovered && Date.now() - busySilentSince > 60000) {
                throw new Error('Webchat tab still generating without progress after fresh-chat recovery — retry after it finishes');
            }
        }
        // 08-24 (investigator 1): gemini phantom-stop stability counter —
        // consecutive polls where the newest row's text is unchanged, reset on
        // any movement so a streaming row never trips the stable-accept above.
        if (isGeminiWebchat()) {
            geminiStablePolls = (state.text && state.text === lastText) ? geminiStablePolls + 1 : 0;
        }
        lastProgressLen = progressLen;
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
    // 08-24 (investigator 1): gemini phantom-stop stability also tracked here
    // (the main loop's counter is shared) — see the busyNow branch below.
    let geminiRescuePrev = '';
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
            // 08-24 (transport audit): was `state.mode` — `state` is
            // block-scoped to the poll loop above, so this threw a silent
            // ReferenceError (swallowed by the catch below) on EVERY rescue
            // iteration: the DOM timeout-rescue never ran and every deadline
            // expiry burned the whole hardCap before the "Timed out" throw.
            // Use the FRESH snapshot (`last`), which is also more correct.
            const busyNow = last.mode === 'vl' ? await isGenerating() : await isForeignBusy();
            if (busyNow) {
                console.log('⏱ still generating past the deadline — extending (bounded by hard cap)');
                // 08-24 (investigator 1): gemini phantom-stop rescue. The
                // ghost "Stop response" control keeps busyNow true past the
                // deadline even though the reply is committed in the DOM —
                // the old code spun to the hard cap and THREW for an answer
                // already there (the 1348s "OK" burned then rescued only
                // when the ghost finally cleared). Same 6-poll stability
                // rule as the main loop: a non-truncated answer unchanged
                // across ~9s of rescue polls is committed — deliver it.
                const ansNow = (last.answer || '').trim();
                if (isGeminiWebchat() && ansNow.length > 0 && ansNow === geminiRescuePrev
                    && geminiStablePolls >= 6 && !looksLikeTruncatedAnswer(ansNow)
                    && !/^You have access to the tools below/.test(ansNow)) {
                    console.log('⏱ gemini phantom stop — rescuing the committed answer from the DOM');
                    return last.answer;
                }
                if (ansNow !== geminiRescuePrev) {
                    geminiStablePolls = 0;
                    geminiRescuePrev = ansNow;
                } else {
                    geminiStablePolls++;
                }
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
// 09-05 (tab leak): FRESH_PER_SEND opens a chat per send, but openNewChat can
// only REUSE a tab that is still at the origin root — once the tab it used
// becomes a /a/chat/s/ thread (or a send fails and strands it), the next call
// falls through to browser.newPage(). Nothing ever closed the tab it walked
// away from, so the driver accumulated one orphan per send: 48 deepseek tabs
// were live on 09-05, only one holding a real conversation, costing ~2.5 GB on
// a box that swaps at 13/14 GiB. Reap surplus ROOT tabs before opening another.
// Thread tabs are never touched (reopenThread depends on them), nor is the
// active page, nor any tab belonging to a different webchat host.
const MAX_ROOT_TABS = Number(process.env.MAX_ROOT_TABS || 3);

async function reapSurplusTabs() {
    try {
        if (!browser) return 0;
        const origin = new URL(config.webchatUrl).origin;
        const isThreadTab = (p) => /\/a\/chat\/s\//.test(p.url());
        const pages = await browser.pages();
        const roots = pages.filter((p) => {
            if (p === page) return false;
            let u = '';
            try { u = p.url(); } catch { return false; }
            if (!u.startsWith(origin)) return false;
            if (isThreadTab(p)) return false;
            return u.replace(/\/(a\/chat\/(new)?)?$/, '') === origin;
        });
        if (roots.length <= MAX_ROOT_TABS) return 0;
        const doomed = roots.slice(0, roots.length - MAX_ROOT_TABS);
        let closed = 0;
        for (const p of doomed) {
            try { await p.close(); closed += 1; } catch { /* already gone */ }
        }
        if (closed) {
            console.log(`🧹 reaped ${closed} surplus ${origin} tab(s) — ` +
                        `${roots.length - closed} root tab(s) kept`);
        }
        return closed;
    } catch (e) {
        console.log('⚠ tab reap skipped:', String(e.message).slice(0, 80));
        return 0;
    }
}

// 09-05: `opts.mode` ('instant' | 'expert') picks the mode selected on the
// fresh composer BEFORE the first message locks the thread. It used to be
// hard-wired to INSTANT, which is why a FORCE_EXPERT swap that opened a chat
// and selected EXPERT was immediately undone by the next openNewChat() —
// the ping-pong that ran on every single send of the ds-gw lanes.
async function openNewChat(opts = {}) {
    const mode = opts.mode || (process.env.FORCE_EXPERT === '1' ? 'expert' : 'instant');
    // Fresh CDP session like every send (stale-session refresh).
    await initBrowser({ reconnect: true });
    await reapSurplusTabs();
    // Re-pick the pinned tab (the old thread's tab gets navigated away — the
    // conversation stays safe server-side).
    if (!page && config.cdpWsUrl) {
        const pages = await browser.pages();
        if (config.tabUrlSubstring) {
            page = pages.find((p) => p.url().includes(config.tabUrlSubstring));
        } else {
            // 08-30 same fix as connectToWebchat: never navigate an OLD
            // /a/chat/s/ thread tab away for a new chat when a root tab exists;
            // the old thread stays pinned for reopenThread.
            const origin = new URL(config.webchatUrl).origin;
            const isThreadTab = (p) => /\/a\/chat\/s\//.test(p.url());
            page =
                pages.find((p) => !isThreadTab(p) && p.url().startsWith(origin)) ||
                pages.find((p) => p.url().startsWith(origin));
        }
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
    // DeepThink/Search toggles, so selectInstantMode found no tabs there and
    // every swap created the wrong mode → perpetual swap churn. Navigate to
    // /a/chat/new instead.
    const newChatUrl = new URL(config.webchatUrl).host.includes('deepseek')
        ? 'https://chat.deepseek.com/a/chat/new'
        : config.webchatUrl;
    await page.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForChatInput();
    // 09-05: was a blind `sleep(2500)`. The gate below verifies the composer is
    // actually mounted and interactive instead of guessing, and returns early
    // on a settled tab.
    await waitComposerReady();
    generationErrHealed = false; // fresh chat = clean slate; re-arm banner heal (08-24)
    // 08-17 (user rule): mode is locked at thread creation — select the mode
    // on the fresh new-chat composer BEFORE the first message creates the
    // thread (an expert thread can never become instant afterwards).
    if (new URL(config.webchatUrl).host.includes('deepseek')) {
        if (mode === 'expert') await selectExpertMode();
        else await selectInstantMode();
        // 09-05: the mode radio swaps the composer subtree — the old blind
        // `sleep(500)` is the exact window the strand was typed into.
        await waitComposerReady();
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
// 4c. THREAD REOPEN (08-24, user): resume a captured chat thread
// ──────────────────────────────────────────────────────
// openNewChat navigates the pinned tab AWAY from the thread it was on — and
// lanes serve MANY personas, so the persona's prior thread is never the tab's
// thread on return. The conversation survives server-side; resuming it is an
// explicit goto to the saved thread URL (origin + /s/<uuid> for deepseek,
// /app/<id> for gemini). Same tab-pick prologue as openNewChat.
async function reopenThread(threadUrl) {
    await initBrowser({ reconnect: true });
    if (!page && config.cdpWsUrl) {
        const pages = await browser.pages();
        page = config.tabUrlSubstring
            ? pages.find((p) => p.url().includes(config.tabUrlSubstring))
            : pages.find((p) => p.url().startsWith(new URL(config.webchatUrl).origin));
        if (!page) page = await browser.newPage();
    }
    if (!page) page = await browser.newPage();
    console.log(`🔁 Reopening thread: ${threadUrl}`);
    await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForChatInput();
    await sleep(2500); // let the SPA settle the thread's composer
    console.log(`🟢 Thread reopened: ${page.url()}`);
    return page;
}

// ──────────────────────────────────────────────────────
// 5. BUILD PROMPT WITH TOOLS
//    Tool definitions section is capped at TOOL_CONTEXT_WINDOW
//    chars so huge tool schemas don't eat the chat's context.
// ──────────────────────────────────────────────────────
function buildFullPrompt(userPrompt, toolDefinitions, systemText) {
    let fullPrompt = '';

    // 09-04 (user): SYSTEM FIRST — rules on top, trimmed tool list (names +
    // short params, no schema dumps), the task after. Up to 5 INDEPENDENT
    // tool calls per reply; tool outputs land at the bottom of the chat.
    // 09-05 FIX (executor contract): engine/fix-executor requests send their
    // OWN system instruction (EXEC_SYSTEM / VERIFY_SYSTEM — the one that says
    // ONE JSON object, no fences, no prose). The generic wrapper below used to
    // OVERRIDE it, and the final REMINDER ("fenced JSON… submit_answer") won
    // the strongest-memory slot — the engine's system never actually drove the
    // model. When a system text is present, IT is ### SYSTEM: the wrapper's
    // rules + reminder switch to a pass-through form so the caller's format
    // contract wins everywhere (top slot AND final reminder).
    const hasSys = !!(systemText && String(systemText).trim());
    fullPrompt += '### SYSTEM\n\n';
    if (hasSys) {
        fullPrompt += String(systemText).trim() + '\n\n';
    } else {
        fullPrompt += 'You are an autonomous coding agent. You answer the USER REQUEST with tool calls.\n' +
        'RULES:\n' +
        '1. Respond ONLY in English.\n' +
        '2. Tool calls: fenced ```json blocks. You may include up to 5 tool calls in ONE reply.\n' +
        '3. Only batch INDEPENDENT calls: none may depend on another call’s output; never read and write the same file in one batch; never run commands that need each other’s results.\n' +
        '4. When finished, submit the answer: {"tool":"submit_answer","params":{"text":"..."}}. No plain-text replies outside submit_answer.\n\n';
    }

    fullPrompt += '### TOOLS\n\n';
    if (toolDefinitions && toolDefinitions.length > 0) {
        for (const tool of toolDefinitions) {
            const argNames = Object.keys((tool.parameters && tool.parameters.properties) || {}).join(', ');
            fullPrompt += `- ${tool.name}: ${tool.description} (params: ${argNames || 'none'})\n`;
            if (fullPrompt.length > config.toolContextWindow) {
                fullPrompt += '…(tool list truncated)\n';
                break;
            }
        }
    }
    fullPrompt += '\n';

    fullPrompt += `### USER REQUEST\n\n${userPrompt}\n\n`;

    // Strongest final slot (reinforces format every round — DeepSeek pauses
    // after tool work and writes progress reports; the top rules don't kill it).
    // 09-05: executor requests must NOT hear "fenced JSON / submit_answer" —
    // their system (EXEC_SYSTEM) demands ONE bare JSON object. The generic
    // reminder stays only for the no-system webchat-agent path.
    if (hasSys) {
        fullPrompt += 'REMINDER: follow the ### SYSTEM rules EXACTLY — their output format is authoritative. No fences, no prose, no submit_answer.\n';
    } else {
        fullPrompt += 'REMINDER: reply with fenced JSON tool call(s) — up to 5, independent — or submit_answer when finished. English only.\n';
    }
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
    reopenThread,
    getReqBodyChars,
    getAndClearThinkBuf,
    resetTeeForHandoff,
    takeThreadSwap,
};
