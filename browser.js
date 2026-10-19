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
