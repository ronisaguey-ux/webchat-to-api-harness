const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const config = require('../core/config');
const RATE_LIMIT = require('../runtime/rate_limit');

// ── A webchat stream error, classified so the send gate can act on it ─────────
//
// The upstream model being overloaded arrives as a stream error:
//   "Server busy, please try again later. (finish_reason: generation_timeout)"
// The site's own text says to retry, and one resend survives it. But the send gate in
// server.js only resends when `e.retryable` is set, and this message matches none of
// its patterns — so a transient upstream hiccup surfaced to the caller as a hard 500.
// Measured: a 75-tool-call plan run died exactly here and the whole job was lost to a
// condition that a single resend fixes.
//
// A THROTTLE IS THE OPPOSITE and must not be retried: resending hammers the same
// account and deepens the cooldown. It is checked FIRST because a throttle reads
// "Try again later", which the transient patterns below would otherwise match — that
// collision would disable the cooldown path for every rate-limit error.
const TRANSIENT_STREAM_RE = /server busy|generation_timeout|overloaded|service unavailable|please try again later/i;

function streamError(text) {
    const raw = String(text || '');
    const err = new Error('DeepSeek stream error: ' + raw + ' — wait ~30s and retry');
    err.streamError = true;
    if (RATE_LIMIT.isRateLimitText(raw)) {
        err.rateLimited = true;
    } else if (TRANSIENT_STREAM_RE.test(raw)) {
        err.retryable = true;
    }
    return err;
}

// ── Webchat-mode quirks (09-13) ─────────────────────────────────────────────
// config.quirks comes from the selected mode in harness.config.json. Every
// getter below DEFAULTS TO THE PREVIOUS HARDCODED BEHAVIOUR when the flag is
// absent, so `generic` and any unlisted webchat behave exactly as before.
function quirk(name, dflt) {
    const q = config.quirks || {};
    return Object.prototype.hasOwnProperty.call(q, name) ? !!q[name] : dflt;
}

// 08-14 WEDGE ROOT-CAUSE guard: nothing legitimate is ever near this; it
// exists to turn a runaway tool result into a loud client-visible error
// instead of a silent gateway wedge (see sendPrompt).
// Below the webchat composer's own limit, not above it. Measured on Gemini: the
// composer kept 30,717 of a 150,682-char prompt and the send proceeded anyway, so the
// model worked from a prompt missing its middle. Refusing here is cheaper than typing
// 150K chars into a box that will drop most of them.
const MAX_PROMPT_CHARS = parseInt(process.env.MAX_PROMPT_CHARS || '28000', 10);

let browser = null;

// puppeteer 25 removed Browser#isConnected(); it is now the `connected` getter.
// Support both so an older/newer puppeteer never breaks the connect path.
function browserAlive(b) {
    if (!b) return false;
    try {
        if (typeof b.isConnected === 'function') return b.isConnected();
        if (typeof b.connected === 'boolean') return b.connected;
        return !!b.connection;
    } catch {
        return false;
    }
}
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
// Serialises initBrowser. A stale-session refresh disconnects the CDP session and
// reattaches; two of those overlapping leaves the SECOND one awaiting a connect()
// against a browser the first has just detached, and puppeteer never resolves —
// measured live: /newchat hung indefinitely right after "Attaching to existing
// browser" with no "✅ Attached", so every thread reset silently did nothing and
// each "fresh" chat kept the previous conversation's context.
// One in-flight initialisation at a time; later callers await the same promise.
let _initInFlight = null;
async function initBrowser(opts = {}) {
    if (_initInFlight) return _initInFlight;
    _initInFlight = _initBrowserInner(opts).finally(() => { _initInFlight = null; });
    return _initInFlight;
}

/**
 * Keep the headed browser off the user's screen.
 *
 * The browser runs HEADED on purpose — a real headed session keeps the login
 * (headless gets signed out and is a fingerprint tell) — but Chrome re-raises
 * its own window whenever a page takes focus, so a single minimise does not
 * hold. The owner has had a runaway window appear and closed it by hand twice.
 *
 * `show-window.sh drop` is the owner's own tested mechanism: it minimises AND
 * restarts a guard that re-asserts the minimise every couple of seconds, which
 * is the part a one-shot `xdotool` call is missing.
 *
 * Best-effort by design: a missing script, no DISPLAY, or a headless launch must
 * never block or fail a browser start. The window appearing is a nuisance; a
 * lane that will not start is a bug.
 */
/**
 * The Chrome profile the lane types into.
 *
 * This is the SAME resolution cli/daemon.js uses for its own launch, so the two
 * launch paths cannot drift: an explicit CHROME_PROFILE wins, otherwise
 * <repo>/.webchat/chrome-profile.
 *
 * It is load-bearing, not cosmetic. Without it Puppeteer invents a throwaway
 * profile under /tmp on every launch — measured 2026-09-23, a launch came up on
 * /tmp/puppeteer_dev_chrome_profile-XMZy7h while the signed-in profile (with
 * DeepSeek's `userToken` in localStorage) sat untouched, so the lane reported
 * "Waiting for login" forever. A webchat lane whose profile is ephemeral is a
 * lane that must be logged into by hand every time it starts.
 */
function chromeProfile() {
    return process.env.CHROME_PROFILE || path.join(__dirname, '.webchat', 'chrome-profile');
}

/**
 * Find a CDP websocket for a browser already running on this box, so a later
 * init can ATTACH instead of trying to launch a second instance on a profile
 * Chrome has locked.
 *
 * Probes the conventional debugging ports in order and returns the FIRST live
 * `webSocketDebuggerUrl`, or null when nothing is listening. Never throws —
 * "no browser found" is the normal cold-start answer, not an error.
 */
const CDP_PROBE_PORTS = [9225, 9224, 9222, 9223];
// The CLI gives each extra webchat 9226, 9227, … so a gateway for gate #2 can find
// its own browser. These are probed AFTER CDP_PROBE_PORTS when nothing is configured,
// and are what makes "several webchats at once" reachable rather than theoretical.
const CDP_EXTRA_PORTS = [9226, 9227, 9228, 9229, 9230];

/**
 * The port our OWN launched Chrome should expose CDP on.
 *
 * An explicit CDP_WS_URL names one; otherwise we use the first probe port, which
 * is what the CLI's --remote-debugging-port matches and what `webchat connect`
 * writes into .env. Keeping the launch and the probe on the same port is the
 * whole point: launch on a port nobody probes and the process is unreachable.
 */
function cdpPort() {
    const fromUrl = (config.cdpWsUrl || '').match(/^ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//);
    if (fromUrl) return Number(fromUrl[1]);
    const fromEnv = Number(process.env.CDP_PORT || 0);
    if (fromEnv) return fromEnv;
    return CDP_PROBE_PORTS[0];
}

/**
 * Was this gateway's CDP port CONFIGURED for it, rather than defaulted?
 *
 * True when CDP_WS_URL names a port or CDP_PORT is set in the environment. In a
 * multi-webchat deployment the CLI sets CDP_PORT for every gate, so this is how a
 * gate announces "I have my own browser and must not borrow anyone else's".
 */
function cdpPortIsExplicit() {
    if (/^ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//.test(config.cdpWsUrl || '')) return true;
    return Boolean(Number(process.env.CDP_PORT || 0));
}

/**
 * The ports to try, in order, when looking for a browser to attach to.
 *
 * Pure and exported so the ORDER can be tested without a network: with several
 * webchats connected, getting this order wrong means gate #2's gateway attaches to
 * gate #1's browser — the wrong account answering, with no error anywhere.
 *
 * An explicitly-configured port is probed ALONE. Probing a wider list "just in case"
 * was the fallback of a fixed bug rather than a safety net: when gate #2's own browser
 * had not launched, it found gate #1's browser on the conventional list, attached to it,
 * and answered as the wrong account — while its own browser never started, because
 * attaching had made a launch unnecessary. The two gates then shared one browser, one
 * DISPLAY and one renderer, so a wedged tab in either lane blocked both. A gateway that
 * cannot find its own port must launch its own browser; a different profile's browser is
 * never a usable substitute.
 */
function cdpProbeOrder() {
    const mine = cdpPort();
    if (cdpPortIsExplicit()) return [mine];
    // Unconfigured (single-gate / legacy): nothing has been claimed for us, so the
    // conventional list is the only way to find an already-running browser to attach to.
    return [mine, ...CDP_PROBE_PORTS, ...CDP_EXTRA_PORTS].filter((p, i, a) => p && a.indexOf(p) === i);
}

async function findRunningBrowserWs() {
    // The port we were CONFIGURED for comes first. With several webchats connected at
    // once, 9225 is gate #1's browser — probing the conventional list in order would
    // attach a gateway meant for gate #2 to gate #1's session, which is the wrong
    // account answering. Any port we did not launch is only a fallback.
    for (const port of cdpProbeOrder()) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
                signal: AbortSignal.timeout(1000),
            });
            if (!r.ok) continue;
            const j = await r.json();
            if (j && j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
        } catch (_) {
            // nothing on this port — keep looking
        }
    }
    return null;
}

/**
 * WINDOW VISIBILITY IS THE USER'S CHOICE. The auto-minimise guard is GONE.
 *
 * It used to spawn `show-window.sh drop`: an xdotool guard that re-asserted a
 * minimise every 0.15s, and it was the wrong answer to the right complaint. It
 * could never remove the flash, because it was racing Chrome rather than stopping
 * it — and the raise had a real cause upstream: `newPage()` created its tab with
 * background:false, which ACTIVATES the tab, which makes Chrome restore and raise
 * the minimised window on every send. Fixed at the source in safeNewPage().
 *
 * Two reasons it is not coming back:
 *   1. Chrome no longer raises the window, so there is nothing to re-assert.
 *      Minimise it and it stays minimised; maximise it and it stays maximised.
 *   2. A 150ms poll cannot tell "Chrome raised itself" from "the owner deliberately
 *      restored the window", so it also overrode the owner — and it was X11-only,
 *      so it could never work for Windows users at all.
 *
 * Explicit control is still available and is now cross-platform (CDP
 * Browser.setWindowBounds, implemented by Chrome on Windows, macOS and Linux):
 *     webchat window status | raise | drop
 *     node window.js status | raise | drop      (same thing, direct)
 */
function noWindowGuard() {
    // Deliberately does nothing. See the block comment above: the raise is fixed at
    // the source, so there is no state to re-assert and nothing worth guarding.
}

/**
 * Read the harness browser's window state — cross-platform.
 *
 * CDP's Browser.getWindowForTarget/setWindowBounds are implemented by Chrome on
 * Windows, macOS AND Linux. That is the whole reason this replaced the xdotool
 * script: `minimize-guard.sh` could only ever work on X11, so Windows users had
 * no window control at all.
 */
async function _windowTarget() {
    if (!browser) throw new Error('no browser attached — connect first (`webchat connect`)');
    const pages = await browser.pages();
    const target = page || pages.find((p) => !(typeof p.isClosed === 'function' && p.isClosed())) || pages[0];
    if (!target) throw new Error('no page open to read a window from');
    return target;
}

async function getWindowState() {
    const target = await _windowTarget();
    const session = await target.createCDPSession();
    try {
        const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
        return { windowId, state: (bounds && bounds.windowState) || 'normal', bounds: bounds || {} };
    } finally {
        await session.detach().catch(() => {});
    }
}

const WINDOW_STATES = ['minimized', 'maximized', 'normal', 'fullscreen'];

async function setWindowState(state) {
    const want = String(state || '').trim().toLowerCase();
    if (!WINDOW_STATES.includes(want)) {
        throw new Error(`unknown window state '${state}' — want one of: ${WINDOW_STATES.join(' | ')}`);
    }
    const target = await _windowTarget();
    const session = await target.createCDPSession();
    try {
        const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
        // CDP refuses minimized -> maximized in one step ("restore it to normal state
        // first"), so route through normal. Same reason as window.js.
        const from = (bounds && bounds.windowState) || 'normal';
        if ((want === 'maximized' || want === 'fullscreen') && (from === 'minimized' || from === 'fullscreen')) {
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        }
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: want } });
        return want;
    } finally {
        await session.detach().catch(() => {});
    }
}

async function _initBrowserInner({ reconnect = false } = {}) {
    if (reconnect && browser) {
        // A long-lived CDP session can go stale (evaluates hang while fresh
        // sessions work). Detach and attach again — cheap (~50ms).
        //
        // This is a DELIBERATE disconnect: tell the guard so it does not report
        // a crash for our own stale-session refresh (observed 2026-09-12 — every
        // send logged "Browser disconnected unexpectedly" right after a good
        // response, because this path fires the same 'disconnected' event).
        detachingOnPurpose = true;
        try { await browser.disconnect(); } catch {}
        detachingOnPurpose = false;
        browser = null;
        page = null;
        console.log('🔌 Reconnecting CDP session (stale session refresh).');
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
        attachDisconnectGuard();
        return;
    }

    // ── ATTACH BEFORE LAUNCH (measured 2026-09-23) ──────────────────────────
    // A persistent profile is single-instance: Chrome refuses to start a second
    // process on a locked `userDataDir`. So once a launch path exists, every
    // later init MUST attach to that Chrome rather than launch another — and the
    // reconnect path below makes this mandatory, not theoretical.
    //
    // Before this, a stale-session refresh did `browser.disconnect()` (which
    // LEAVES CHROME RUNNING) and then fell straight through to
    // `puppeteer.launch(... userDataDir ...)` — measured: the first request
    // logged in fine, the very next one died with
    //   "The browser is already running for .../chrome-profile.
    //    Use a different `userDataDir` or stop the running browser first."
    // A working lane that bricks after exactly one message.
    //
    // Cheap and safe to attempt: no Chrome running → 3s probe fails → we launch
    // exactly as before. Chrome running → we attach and the login is preserved
    // (no relaunch, no re-login, no window popped up).
    const browserWs = await findRunningBrowserWs();
    if (browserWs) {
        try {
            console.log(`🔎 Found a browser already holding this profile — attaching instead of launching.`);
            browser = await puppeteer.connect({
                browserWSEndpoint: browserWs,
                defaultViewport: null,
                protocolTimeout: 240000,
            });
            console.log('✅ Attached to the running browser.');
            attachDisconnectGuard();
            return;
        } catch (e) {
            console.log(`⚠️  Attach to the running browser failed (${String(e.message).slice(0, 70)}) — launching fresh.`);
            browser = null;
            page = null;
        }
    }

    console.log('🚀 Launching browser...');
    // detached:true puts Chromium in its own process group so a crash can be
    // reaped with kill(-pid) — orphaned renderer/GPU/zygote children otherwise
    // accumulate as zombies (documented Puppeteer-in-container failure mode).
    browser = await puppeteer.launch({
        headless: config.headless,
        // A persistent profile is what carries the webchat login across restarts.
        // Reusing the CLI's resolution keeps one profile, not two.
        userDataDir: (() => {
            const dir = chromeProfile();
            try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* launch will report */ }
            return dir;
        })(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            // A debugging port is what makes the launched Chrome ATTACHABLE.
            // Without it the process exposes no CDP HTTP endpoint, so a later
            // init can never attach — it can only try to launch a second Chrome
            // on the same locked profile and fail (measured 2026-09-23).
            `--remote-debugging-port=${cdpPort()}`,
            // Pages are created with background:true so Chrome never raises the
            // window (see safeNewPage). These three flags are what make a BACKGROUND
            // tab behave like a foreground one, so nothing downstream regresses:
            // without them a backgrounded tab gets its timers throttled, and a
            // webchat that streams its answer through a timer would stall.
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
        ],
        defaultViewport: { width: 1280, height: 800 },
        detached: true,
    });
    attachDisconnectGuard();
    // No window guard here on purpose — see noWindowGuard(). The window only ever
    // appeared because newPage() activated its tab; with background:true the browser
    // never raises itself, so the window stays however the user left it. If a user
    // does want it moved, that is an explicit, cross-platform command:
    //     webchat window raise | drop | status
    page = await safeNewPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    console.log('✅ Browser ready.');
}

// ──────────────────────────────────────────────────────
// 1b. DISCONNECT GUARD (research: the #1 production Puppeteer failure)
//     'disconnected' cannot tell you WHY the browser went away, so track intent
//     ourselves: a deliberate disconnect (shutdown / stale-session refresh) must
//     NOT trigger a reconnect, and a crash must not spin.
// ──────────────────────────────────────────────────────
let shuttingDown = false;
let detachingOnPurpose = false;
let disconnectHandled = false;

function markShuttingDown() {
    shuttingDown = true;
}

function attachDisconnectGuard() {
    if (!browser || typeof browser.on !== 'function') return;
    disconnectHandled = false;
    browser.once('disconnected', () => {
        if (disconnectHandled) return; // single-flight: the event can fire twice
        disconnectHandled = true;
        if (shuttingDown || detachingOnPurpose) {
            console.log('🔌 Browser disconnected (intentional — shutdown or stale-session refresh).');
            return;
        }
        // Every Page/ElementHandle/CDP session is now invalid — drop them so the
        // next request re-attaches instead of failing with "Target does not
        // belong to session" on stale handles.
        console.error('⚠️  Browser disconnected unexpectedly — clearing page handles.');
        page = null;
        browser = null;
    });
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
// A cached page handle can outlive its frame/renderer: Chrome discards the tab,
// swaps the renderer, or the page navigates, and every call on the old handle
// then throws "Attempted to use detached Frame" / "Target closed". Observed
// 2026-09-12 — the gateway answered a good response, refreshed its CDP session,
// then 503'd the next request with a dead handle and the engine burned a hop.
const STALE_HANDLE_RE = /detached Frame|Session closed|Target closed|Cannot find context|Execution context was destroyed|Protocol error \(Runtime\.callFunctionOn\)/i;

// "Requesting main frame too early!" — puppeteer's frame manager asked for the main
// frame before the target finished attaching. Observed 2026-09-23 as the error that
// ended a plan run right after a page swap. It is the same class as the other stale
// states: the handle is momentarily unusable and the very next attempt (which runs
// the normal connect path and rebuilds the page) succeeds. Treated as stale AND
// retryable; previously it matched nothing, so the send failed outright.
const EARLY_FRAME_RE = /Requesting main frame too early|Cannot read properties of null \(reading 'mainFrame'\)/i;

function isStaleHandleError(e) {
    return STALE_HANDLE_RE.test(String(e && e.message ? e.message : e))
        || EARLY_FRAME_RE.test(String(e && e.message ? e.message : e));
}

// ── DEAD RENDERER (measured 2026-09-23) ─────────────────────────────────────
// A Chromium renderer can die while the BROWSER stays perfectly healthy: the
// tab stops answering CDP entirely, and the failure surfaces as
//   "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting..."
//
// Note that is NOT the same string as the `Protocol error (Runtime.callFunctionOn)`
// in STALE_HANDLE_RE, so it never matched, recovery never fired, and a send sat
// on a corpse until the 900s idle deadline. Measured: `1+1` via CDP returned
// nothing in 20s while /json/version and Target.getTargets both answered
// instantly, every chrome process idled at 0.0% CPU, and Target.closeTarget +
// Target.createTarget from a sibling page recovered a responsive tab in 8ms.
//
// A dead renderer is indistinguishable from a slow one by message alone, so
// this only NAMES the suspect; the decision needs a liveness probe (below).
const RENDERER_TIMEOUT_RE = /callFunctionOn timed out|timed out\. Increase the 'protocolTimeout'|Target closed|Session closed|Cannot find context|detached Frame|Execution context was destroyed/i;

function isRendererTimeoutError(e) {
    return RENDERER_TIMEOUT_RE.test(String(e && e.message ? e.message : e));
}

// How long a bare `1+1` gets before the renderer counts as dead, and how many
// consecutive poll failures are tolerated first. A single failure is normal —
// the page genuinely can cogitate for minutes — so the probe only runs once
// polling has already failed repeatedly.
const RENDERER_PROBE_MS = parseInt(process.env.RENDERER_PROBE_MS || '8000', 10);
const RENDERER_DEAD_AFTER = parseInt(process.env.RENDERER_DEAD_AFTER || '3', 10);

/**
 * Is the renderer answering at all?
 *
 * Raced against a SHORT deadline on purpose: the point is to catch a corpse, and
 * `page.evaluate` on a dead renderer otherwise blocks for the full 240s
 * protocolTimeout — which is the stall this exists to avoid.
 */
async function probeRendererAlive(timeoutMs = RENDERER_PROBE_MS) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
    try {
        const r = await Promise.race([
            page.evaluate(() => 1 + 1),
            new Promise((_, rej) => setTimeout(() => rej(new Error('renderer probe timeout')), timeoutMs)),
        ]);
        return r === 2;
    } catch (_) {
        return false;
    }
}

/**
 * Bound any puppeteer call so a dead renderer becomes a FAST failure.
 *
 * The observed shape (2026-09-23) is
 *   `ProtocolError: Network.enable timed out. Increase the 'protocolTimeout' setting`
 * thrown from CdpPage._create -> FrameManager.initialize -> NetworkManager.addClient:
 * attaching to a target whose renderer is gone blocks for the full 240s
 * protocolTimeout. Every unbounded newPage()/attach in this file was therefore a
 * FOUR-MINUTE stall during which nothing could throw, so no recovery ever ran.
 * Same lesson as boundPoll in the send loop — a recovery path keyed on failure is
 * useless if the call never gets to fail.
 */
async function withDeadline(promise, ms, label) {
    let t;
    try {
        return await Promise.race([
            promise,
            new Promise((_, rej) => {
                t = setTimeout(() => {
                    const e = new Error(`${label} exceeded ${ms}ms — renderer unresponsive?`);
                    e.timedOut = true;
                    rej(e);
                }, ms);
            }),
        ]);
    } finally {
        clearTimeout(t);
    }
}

// Generous compared with the 8s liveness probe: creating a page on a HEALTHY
// browser is fast, but a cold target attach can legitimately take a few seconds.
const PAGE_ACQUIRE_MS = Math.max(5000, parseInt(process.env.PAGE_ACQUIRE_MS || '25000', 10));

/**
 * Does THIS page answer? Bounded, and usable on any page — not just the cached one.
 *
 * `page.url()` is served from cached target metadata, so it happily returns a URL
 * for a renderer that is dead. Selection therefore cannot tell a live tab from a
 * corpse by URL alone, which is how a dead tab kept getting re-acquired.
 */
async function probePageAlive(p, timeoutMs = RENDERER_PROBE_MS) {
    if (!p) return false;
    try {
        if (typeof p.isClosed === 'function' && p.isClosed()) return false;
        return (await withDeadline(p.evaluate(() => 1 + 1), timeoutMs, 'page liveness probe')) === 2;
    } catch (_) {
        return false;
    }
}

/**
 * Open a new page with a deadline, dropping dead targets if the first attach hangs.
 *
 * The retry is only worth making AFTER the corpses are gone: a hung attach leaves
 * the browser in a state where the next attach hangs the same way.
 */
async function safeNewPage() {
    if (!browser) throw new Error('cannot open a page: no browser');
    // background:true is THE fix for the window that jumped onto the owner's screen.
    // Puppeteer's newPage() sends CDP Target.createTarget with background:false,
    // which ACTIVATES the new tab — and activating a tab inside a minimised window
    // makes Chrome restore and raise that window. Measured here: every send that
    // opened a chat un-minimised the browser, which is the half-second flash no
    // minimise-guard could ever win, because the guard was racing Chrome instead of
    // stopping it. The harness never needs the tab foregrounded: it drives the page
    // over CDP, and the anti-throttling flags below keep a background tab fully live.
    const BG = { background: true };
    try {
        return await withDeadline(browser.newPage(BG), PAGE_ACQUIRE_MS, 'browser.newPage()');
    } catch (e) {
        if (!e.timedOut) throw e;
        console.log(`⚠️  newPage timed out (${e.message}) — dropping dead webchat targets, retrying once`);
        await closeDeadWebchatTargets().catch(() => {});
        return await withDeadline(browser.newPage(BG), PAGE_ACQUIRE_MS, 'browser.newPage() retry');
    }
}

/**
 * Close every webchat page target, so the NEXT page acquisition cannot re-acquire
 * the corpse.
 *
 * This step is not optional. Page selection prefers an origin match, so leaving a
 * dead tab in `browser.pages()` means the very next connect attaches straight
 * back to it and the lane is wedged again — measured: a reload of the dead tab
 * changed nothing, because a dead renderer never processes the navigation.
 *
 * `Target.closeTarget` is sent from a SIBLING page's session, because the dead
 * page cannot service one. Returns the number of targets closed.
 */
async function closeDeadWebchatTargets() {
    if (!browser) return 0;
    let via = null;
    try {
        const pages = await browser.pages();
        via = pages.find((p) => p !== page && !(typeof p.isClosed === 'function' && p.isClosed())) || null;
        // Bounded: this runs INSIDE the recovery path, so an unbounded attach here
        // would hang the very code that exists to break a hang.
        if (!via) via = await withDeadline(browser.newPage({ background: true }), PAGE_ACQUIRE_MS, 'recovery newPage()');
    } catch (_) {
        return 0;
    }
    let cdp;
    try {
        cdp = await via.createCDPSession();
    } catch (_) {
        return 0;
    }
    const host = (() => { try { return new URL(config.webchatUrl).host; } catch (_) { return 'chat.deepseek.com'; } })();
    let closed = 0;
    try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        for (const t of targetInfos || []) {
            if (t.type !== 'page') continue;
            if (!String(t.url || '').includes(host)) continue;
            try {
                await cdp.send('Target.closeTarget', { targetId: t.targetId });
                closed += 1;
            } catch (_) { /* already gone */ }
        }
    } catch (_) {
        // fall through — returning 0 still lets the caller null the handle
    } finally {
        try { await cdp.detach(); } catch (_) { /* detach is best-effort */ }
    }
    return closed;
}

/**
 * Drop a dead renderer and leave the module in a state where the normal connect
 * path builds a fresh page.
 *
 * Deliberately does NOT re-attach here: `sendPrompt` already calls
 * `initBrowser({ reconnect: true })` then `connectToWebchat(...)`, and that path
 * does the user-agent, asset-blocking and tee setup. Duplicating it would give
 * two page-setup code paths that can drift.
 */
async function dropDeadRenderer(reason) {
    console.log(`🧟 renderer unresponsive (${reason}) — closing the dead tab so the next connect builds a fresh page`);
    const closed = await closeDeadWebchatTargets();
    page = null;
    console.log(`♻️  dead renderer cleared (${closed} target(s) closed)`);
    return closed;
}


// Probe the cached page; on a dead handle, drop it and re-attach once.
async function ensureLivePage() {
    if (!page) return;
    try {
        await page.evaluate(() => 1);
    } catch (e) {
        if (isStaleHandleError(e)) {
            console.log(`♻️  Stale page handle (${String(e.message).slice(0, 60)}) — re-attaching.`);
            page = null;
            await initBrowser({ reconnect: true });
            return;
        }
        if (isRendererTimeoutError(e)) {
            // A timeout is not a stale handle: the browser is fine, the renderer
            // is not. It must be CLOSED, not just forgotten — page selection
            // prefers an origin match and would otherwise re-acquire the corpse.
            await dropDeadRenderer(String(e.message).slice(0, 60));
            return;
        }
        throw e;
    }
}

// Public entry: attach to the webchat tab, retrying ONCE if the page handle dies
// mid-setup. The handle can go stale at any point (probe, waitForChatInput, CDP
// session setup) and each site used to surface as its own 503 to the engine.
async function connectToWebchat(webchatUrl) {
    try {
        return await connectToWebchatOnce(webchatUrl);
    } catch (e) {
        if (!isStaleHandleError(e)) throw e;
        console.log(`♻️  connect failed on a dead handle (${String(e.message).slice(0, 60)}) — re-attaching and retrying once.`);
        page = null;
        await initBrowser({ reconnect: true });
        return await connectToWebchatOnce(webchatUrl);
    }
}

async function connectToWebchatOnce(webchatUrl) {
    if (!page) await initBrowser();

    // Probe first; on a stale handle, drop it and re-attach before doing work.
    await ensureLivePage();

    // A page handle must exist by now. `initBrowser()` returns early with
    // "Browser already connected" when the browser object is alive — and that
    // path acquires NO page, so `page` stays null and the first real call dies on
    // `null.setCookie`. The tab-selection block below only runs for a browser we
    // actually hold, so make the page a hard precondition here instead of
    // assuming initBrowser always assigns one.
    if (!page) {
        if (!browser) throw new Error('No browser and no page — cannot connect to webchat');
        const existing = await browser.pages();
        page = existing.find((p) => p.url().startsWith(new URL(webchatUrl).origin)) || existing[0] || null;
        if (!page) page = await safeNewPage();
        console.log(`📄 Acquired page after init (${page.url()})`);
    }

    // A cached `page` can outlive its frame: Chrome swaps the renderer (tab
    // discarded, crash, or the page navigated) and every call on the old handle
    // throws "Attempted to use detached Frame '<id>'". Observed 2026-09-12 — the
    // gateway answered a good response, refreshed its CDP session, then 503'd the
    // next request with a detached frame and the engine burned a hop on it.

    // Tab selection must run whenever a browser exists — not only when CDP_WS_URL
    // is configured. Gated on `config.cdpWsUrl` (its original form), a LAUNCHED
    // browser skipped every branch below, left `page` null, and the next call died
    // on `null.setCookie` (measured 2026-09-23).
    if (browser) {
        const pages = await browser.pages();
        // TAB_URL_SUBSTRING mode (second instance, 08-12): match the tab whose
        // URL contains the pinned thread id, never an arbitrary deepseek tab —
        // two gateway instances share one browser, each driving its own thread.
        if (config.tabId) {
            // Exact target, for tabs that cannot be told apart by URL.
            for (const p of pages) {
                try {
                    const s = await p.createCDPSession();
                    const info = await s.send('Target.getTargetInfo');
                    await s.detach();
                    if (info && info.targetInfo && info.targetInfo.targetId === config.tabId) {
                        page = p;
                        break;
                    }
                } catch (_) {
                    /* a page we cannot query is a page we cannot use */
                }
            }
            if (page) {
                console.log(`🎯 Pinned to tab id ${config.tabId}`);
            } else {
                // A stale pin must NOT spawn a tab: TAB_IDs die whenever the tab
                // is re-created (Gemini resets a new chat to /app, so every
                // re-pin looks like the same URL), and one new tab per request is
                // how the browser ends up with six copies of the same thread.
                // Fall back to the URL substring, then to any matching-origin
                // tab, and only open one when the browser genuinely has none.
                page = (config.tabUrlSubstring && pages.find((p) => p.url().includes(config.tabUrlSubstring)))
                    || pages.find((p) => p.url().startsWith(new URL(webchatUrl).origin));
                if (page) {
                    console.log(`⚠️  no tab with id ${config.tabId} — reusing ${page.url()}`);
                } else {
                    console.log(`🆕 No tab for ${webchatUrl} — opening one`);
                    page = await safeNewPage();
                    await page.goto(webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                }
            }
        } else if (config.tabUrlSubstring) {
            page = pages.find((p) => p.url().includes(config.tabUrlSubstring));
            if (!page) {
                console.log(`🆕 No tab matching ${config.tabUrlSubstring} — opening one`);
                page = await safeNewPage();
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
                page = await safeNewPage();
                await page.goto(webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }
        }
        console.log(`🟢 Reusing tab: ${page.url()}`);
        // ── PROBE THE SELECTED TAB (2026-09-23) ─────────────────────────────
        // `page.url()` comes from cached target metadata, so a tab whose renderer
        // is DEAD still reports a perfectly good URL. Selection prefers an origin
        // match, so that corpse is chosen again on every connect and every later
        // call hangs — measured as `ProtocolError: Network.enable timed out` out of
        // CdpPage._create, i.e. a 240s stall that never threw and so never recovered.
        //
        // One bounded probe here is cheap and decisive: it converts "attach to a
        // corpse and hang" into "notice, replace the tab, carry on".
        if (!(await probePageAlive(page))) {
            console.log('💀 selected tab does not answer (dead renderer) — replacing it');
            await closeDeadWebchatTargets().catch(() => {});
            page = null;
            page = await safeNewPage();
            await page
                .goto(webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
                .catch(() => { /* the caller's own waits will surface a real problem */ });
            console.log(`🆕 Replaced with a fresh tab: ${page.url()}`);
        }
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

// Login gate.
//
// ⚠️ The presence of the chat input is NOT a login signal, and treating it as one cost
// real throughput: gemini and chatgpt both render a usable-looking composer to a
// LOGGED-OUT visitor. waitForChatInput() found it, logged '✅ Chat input found — logged
// in.', and the send then typed into a composer that could never submit — the prompt sat
// in the box, no response ever arrived, and the request died on its timeout. Measured on
// a logged-out gemini: composer present, 12584 chars stuck in it, a visible 'Sign in'
// button, and the log claiming it was logged in. A lane that lies about being ready is
// worse than one that reports it is not: the caller spends the whole timeout instead of
// being told to log in.
//
// So the gate now requires BOTH: a composer, and no visible logged-out CTA. The signals
// are read from the DOM (visibility, not mere presence) because these SPAs keep the
// signed-out markup in the tree.
const LOGGED_OUT_SELECTORS = [
    'button[aria-label="Sign in"]',
    'a[href*="accounts.google.com/ServiceLogin"]',
    'a[href*="/auth/login"]',
    '[data-testid="login-button"]',
    'button[data-testid="login-button"]',
];
const LOGGED_OUT_TEXT = /\b(sign in|log in|sign up to|log in to get answers|sign in to save activity)\b/i;

async function isLoggedOut(p) {
    try {
        const state = await p.evaluate((sels, reSrc) => {
            const re = new RegExp(reSrc, 'i');
            const visible = (el) => !!el && el.offsetParent !== null && (el.innerText || el.textContent || '').trim() !== '';
            for (const s of sels) {
                const el = document.querySelector(s);
                if (visible(el)) return { loggedOut: true, why: 'selector ' + s };
            }
            // A sign-in CTA that is on screen and near the top is the account gate.
            const top = (document.body.innerText || '').slice(0, 1200);
            if (re.test(top)) return { loggedOut: true, why: 'sign-in copy near top' };
            return { loggedOut: false, why: null };
        }, LOGGED_OUT_SELECTORS, LOGGED_OUT_TEXT.source);
        return state;
    } catch {
        // Cannot tell — do NOT claim logged in, but do not fail the gate on a flaky read
        // either. The send path has its own guard.
        return { loggedOut: false, why: null, unknown: true };
    }
}

async function waitForChatInput(targetPage) {
    const p = targetPage || page;
    const deadline = Date.now() + config.loginWaitMs;
    let warned = false;
    while (Date.now() < deadline) {
        const el = await firstMatch(config.selectors.input);
        if (el) {
            const out = await isLoggedOut(p);
            if (!out.loggedOut) {
                console.log('✅ Chat input found — logged in.');
                return;
            }
            if (!warned) {
                console.log(`🟡 Chat input present but the page is SIGNED OUT (${out.why}) — not treating that as ready.`);
                warned = true;
            }
        } else if (!warned) {
            console.log('🟡 Waiting for login — log into the browser window if prompted...');
            warned = true;
        }
        await sleep(3000);
    }
    throw new Error(
        `Login wait timed out after ${config.loginWaitMs / 1000}s — no usable chat input. ` +
        'A composer was found but the page is signed out, so a send would never submit. ' +
        'Log in manually, then POST /connect.'
    );
}

// ──────────────────────────────────────────────────────
// 4. SEND PROMPT + GET RESPONSE
// ──────────────────────────────────────────────────────
// ── dead-tab self-heal (09-15) ─────────────────────────────────────────────
// Ported from another agent's gateway-resilience guide, kept only where it fits
// THIS harness (their `page.reload({waitUntil:'networkidle2'})` is Puppeteer —
// Playwright has no networkidle2 — and their `.main_reply_seen_[PORT].json`
// outbox markers do not exist here, so that step is dropped rather than faked).
//
// Why it exists: measured on the freebuff lane, a send sat for 9m21s while the
// tab produced nothing at all, and because sends are serialized per account that
// wedged the whole lane to the hard cap. The gateway had no way to tell "still
// thinking" from "tab is dead" — it just waited.
//
// The discriminator is the same one the guide proposes: if the tab is NOT
// generating (no stop control) AND no new text has arrived for a long while,
// the tab is dead, not slow. Recover it instead of waiting out the cap.
async function isTabGenerating() {
    try {
        const state = await Promise.race([
            page.evaluate(() => {
                const stop = document.querySelector(
                    '[data-testid="stop-button"], button[aria-label*="Stop" i], [class*="stop"]');
                return { stop: !!stop };
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('cdp poll timeout')), 8000)),
        ]);
        return !!state.stop;
    } catch {
        return null;              // unknown — let the caller stay conservative
    }
}

async function selfHealDeadTab(reason) {
    console.log(`🩹 dead tab detected (${reason}) — reloading and waiting for the composer`);
    try {
        await Promise.race([
            page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('reload timeout')), 50000)),
        ]);
    } catch (e) {
        console.log(`🩹 reload failed: ${e.message}`);
        return false;
    }
    // Poll for the composer rather than assuming the reload was enough.
    const sel = config.selectors && config.selectors.input
        ? config.selectors.input : 'textarea, div[contenteditable="true"]';
    for (let i = 0; i < 20; i++) {
        await sleep(1500);
        try {
            const ok = await page.evaluate((s) => {
                const el = document.querySelector(s);
                return !!(el && el.offsetParent !== null);
            }, sel);
            if (ok) {
                console.log('✅ Chat input found — logged in.');
                return true;
            }
        } catch { /* keep polling */ }
    }
    console.log('🩹 composer did not come back after reload');
    return false;
}

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
    // 09-22 B5: apply the configured model before the send (no-op if unset or the
    // picker is not found — a missing picker must never block a send).
    await setModel();
    // 09-14 (owner): Freebuff resets reasoning effort to "Max" on new chat; a
    // reused tab keeps whatever it had. Pin it to "Low" before every send so the
    // thinking model never cooks the timeout — cheap, idempotent, freebuff-only.
    if (new URL(config.webchatUrl).host.includes('freebuff')) {
        await setReasoningEffortLow();
    }
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
    const _budget = Math.max(60000, parseInt(process.env.HARD_CAP_MS) || (config.timeout || 300000));
    // 09-16 (owner): "js have the timer stop once a first stream is detected."
    // Fresh progress stamp for THIS send, so the idle deadline below starts from
    // now and cannot inherit the previous send's silence (or its progress).
    markProgress();
    const text = await withAbsoluteDeadline(
        waitForResponse(before, fullPrompt), _budget + 15000, 'waitForResponse');
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

// 08-14 (user rule): the deepseek tab runs in EXPERT mode, which has ONLY the
// DeepThink chip (instant mode is the one with DeepThink + Search — the chip
// set IS the mode). So keep DeepThink on and NEVER touch Search: force-on it
// on an instant thread would lock that thread into instant. Idempotent, every
// request (a reload or tab flip can reset the chips). Foreign webchats have
// no such chips — harmless no-op.
//
// 09-22 B1 (owner): "for deepseek or gemini, its not needed cuz they have native
// websearch capabilities, just have it so that the user can config on deepseek
// deepthink and search on". ensureToggles is now CONFIG-DRIVEN instead of
// DeepThink-force-on: it sets the DeepThink and Search chips to whatever
// webchatModes.<mode>.native.deepThink / .search say (DeepThink defaults ON,
// Search defaults OFF). MEASURED DOM (probed live, current DeepSeek composer):
//   chips are .ds-toggle-button, labelled by their text "DeepThink" / "Search",
//   state is aria-pressed="true"|"false". Gemini has NO such chips — its search
//   is built into the model, so for gemini this is a no-op and native search is
//   simply ON when the model is asked (recorded, not faked).
/**
 * Per-request toggle state, derived from the model id the caller asked for.
 *
 * The harness can only choose a MODEL, so every toggle COMBINATION is published as a
 * model id (see webchat-models.js) and server.js parses it back into this state
 * before the send. Without this the chips would only ever follow the static config,
 * and "pick a different model to change the webchat's settings" would be a lie.
 */
let _requestToggles = null;
let _requestModel = null;
function setRequestToggles(state, parsed) {
    _requestToggles = state || null;
    _requestModel = parsed || null;
}

/**
 * Move the conversation into a FRESH chat without losing its context.
 *
 * Some toggles are baked into the thread when it starts (ChatGPT's Think, Freebuff's
 * reasoning effort), so switching to them means a new chat — and a new chat normally
 * means throwing the conversation away. This asks the CURRENT thread to summarise
 * itself, opens the new chat with the toggle already applied, and injects that
 * summary as the first message, so the choice costs the user nothing.
 *
 * Ordered deliberately: summarise BEFORE navigating, because openNewChat() destroys
 * the page the summary has to come from.
 */
async function carryContextToNewChat() {
    let summary = '';
    try {
        console.log('📝 toggle needs a fresh chat — asking for a compact summary first');
        const r = await sendPrompt(
            'Summarise this conversation for a FRESH thread that has no memory of it. '
            + 'Include: the task and its goal, decisions already made, files or facts established, '
            + 'what is still open, and any constraint that must not be broken. '
            + 'Be compact and concrete. Reply with the summary only.',
            null,
        );
        summary = String((r && (r.text || r.content)) || '').trim();
        console.log(`📝 summary captured (${summary.length} chars)`);
    } catch (e) {
        // Best effort by design: a failed summary must not block the new chat, or a
        // toggle the user asked for would become unreachable.
        console.log('⚠ could not summarise before the reset:', String(e.message).slice(0, 70));
    }

    await openNewChat();

    if (summary) {
        try {
            await sendPrompt(
                'Context carried over from the previous thread (this chat is new and has no memory of it):\n\n'
                + summary
                + '\n\nAcknowledge briefly, then wait for the next instruction.',
                null,
            );
            console.log('📥 summary injected into the new chat');
        } catch (e) {
            console.log('⚠ could not inject the summary:', String(e.message).slice(0, 70));
        }
    }
    return summary;
}

async function ensureToggles() {
    try {
        // A model id that named toggles wins over the static config; the id IS the
        // user's choice. Keyed by the registry's ids so a rename cannot drift.
        const W = require('../models/webchat-models');
        const siteId = (_requestModel && _requestModel.site) || '';
        const site = W.SITES[siteId] || null;
        const wantDeepThink = (_requestToggles && 'deepthink' in _requestToggles)
            ? _requestToggles.deepthink : config.nativeDeepThink;
        const wantSearch = (_requestToggles && 'search' in _requestToggles)
            ? _requestToggles.search : config.nativeSearch;
        // Every declared toggle for this site, as {uiLabel, want}. Chips are matched
        // by their own text, which is how DeepSeek labels them.
        const wanted = site
            ? (site.toggles || []).map((t) => ({ ui: t.ui, want: (_requestToggles ? _requestToggles[t.id] === true : t.default === true) }))
            : [{ ui: 'DeepThink', want: wantDeepThink }, { ui: 'Search', want: wantSearch }];
        const clicked = await page.evaluate(({ wantDeepThink, wantSearch }) => {
            const flipped = [];
            for (const el of document.querySelectorAll('.ds-toggle-button')) {
                const label = (el.textContent || '').trim();
                const on = el.getAttribute('aria-pressed') === 'true';
                const hit = wanted.find((w) => w.ui === label);
                if (hit && on !== hit.want) {
                    el.click();
                    flipped.push(`${label} ${hit.want ? 'ON' : 'OFF'}`);
                }
            }
            return flipped;
        }, { wanted });
        if (clicked && clicked.length) console.log('🧠 native toggles:', clicked.join(', '));
    } catch (e) {
        console.log('⚠ toggle ensure failed:', String(e.message).slice(0, 60));
    }
}

// 09-22 B5 (owner): "allow the user to pick specific models inside the webchat
// inside the cli". config.webchatModel records the model; this sets it in the
// tab's OWN picker before a send. MEASURED DOM (probed live 09-22):
//   gemini -> button[aria-label^="Open mode picker"] opens a menu; the options
//             are menuitems whose text names the model ("Gemini Flash", "Gemini
//             2.5 Pro", …). Click the option whose text matches the config.
//   deepseek -> picker lives in the composer header (discover on a live deepseek
//             tab; not reachable from this install — only the gemini tab is open).
// A no-op (and a log line) when the model is blank or the control is not found —
// a missing picker must never block a send.
async function setModel() {
    const want = (config.webchatModel || '').trim();
    if (!want) return;
    try {
        const host = new URL(config.webchatUrl).host;
        if (host.includes('gemini')) {
            const opened = await page.evaluate(() => {
                const btn = document.querySelector('button[aria-label^="Open mode picker"]');
                if (btn) { btn.click(); return true; }
                return false;
            });
            if (!opened) { console.log('⚠ model picker button not found — leaving model as-is'); return; }
            await sleep(400);
            const set = await page.evaluate((want) => {
                const opts = [...document.querySelectorAll('[role="menuitem"], [role="option"]')];
                const match = opts.find((o) => (o.textContent || '').trim() === want)
                    || opts.find((o) => (o.textContent || '').trim().includes(want));
                if (!match) return { ok: false, have: opts.map((o) => (o.textContent || '').trim()).filter(Boolean).slice(0, 12) };
                match.click();
                return { ok: true };
            }, want);
            if (set.ok) console.log(`🎛️ model set to "${want}"`);
            else console.log(`⚠ model "${want}" not in picker; available: ${set.have.join(', ')}`);
        } else {
            // deepseek and others: a selector must be configured (discovered live);
            // without one, leave the model untouched and say so once.
            console.log('⚠ model picker not configured for this lane — set webchat.model and add a per-mode selector');
        }
    } catch (e) {
        console.log('⚠ setModel failed:', String(e.message).slice(0, 60));
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
            // 09-17: this used to be treated as a HARD failure, on the owner's old rule
            // "if u see a search option that means its not expert". That rule described a
            // UI that no longer exists. Probed live on the current composer:
            //   radioGroups: 0   radios: []   ("Instant / Expert" tabs are GONE)
            //   toggleChips: ["DeepThink","Search"]   deepThinkPressed: "true"
            // There are no mode tabs to select, so this branch fires on EVERY swap and is
            // a FALSE ALARM - the thread is fine, DeepThink (the reasoning signal that
            // actually matters) is ON. Report the real state instead of a failure, so the
            // log stops claiming ~30 sends/hour are non-expert when they are not.
            const dtOn = await page.evaluate(() => {
                const el = [...document.querySelectorAll('[aria-pressed]')]
                    .find((x) => (x.textContent || '').trim() === 'DeepThink');
                return el ? el.getAttribute('aria-pressed') === 'true' : null;
            });
            if (dtOn === true) {
                console.log('🧠 DeepThink ON — mode tabs absent (current UI), thread is fine');
                return true;
            }
            console.log('⚠ DeepThink is NOT on and no mode tabs exist — thread may be instant');
            return false;
        } else {
            console.log(flipped && flipped.length
                ? '🧠 new chat set to EXPERT mode (' + flipped.join(', ') + ') — Search absent, verified'
                : '🧠 already expert (no Search option, DeepThink on)');
            return true;
        }
    } catch (e) {
        console.log('⚠ selectExpertMode failed:', String(e.message).slice(0, 60));
        return false;
    }
}

// ── Type into the chat input ──
// Prefer the React-safe native-setter path (fast, works on textareas);
// contenteditable editors (Gemini, …) fall back to focused insertText.
// ⚠️ NEVER use page.keyboard.type() for multi-line prompts: it translates
// "\n" into Enter keypresses, which SENDS the partial message mid-prompt.
// 09-14 (worker): host gate. browser.js is SHARED with the deepseek and gemini
// lanes, so every ChatGPT-specific behaviour is gated exactly the way the
// existing empty-grace gate is (see waitForResponse).
function _isChatGptHost() {
    try { return new URL(config.webchatUrl).host.includes('chatgpt'); }
    catch (e) { return false; }
}

// 09-14 (worker, brief Part A): CARET-ANCHORED, VERIFIED CHUNKED INSERT.
//
// Root cause of the "blank screen / no message history" + empty-response
// reports: `Input.insertText` inserts at the composer's CURRENT selection.
// ChatGPT's composer is ProseMirror, which re-renders and REMAPS the selection
// asynchronously whenever an inserted chunk contains newlines (each newline
// becomes a new paragraph node). The old loop fired chunks 60ms apart with no
// caret control, so a chunk that landed while ProseMirror was normalising went
// in at a STALE offset. Measured live on the owner's tab: the user rows held
// interleaved text — `M appe_scaffold.dart` (the middle of
// `app/lib/widgets/responsive_scaffold.dart` overwritten) and
// `RUN VERIFICATION NOW./lib/widgets/responsiv` (the END of the prompt sitting
// BEFORE the middle of it). A scrambled prompt is why the model answered
// `cannot-fix` / empty on a contract it could otherwise satisfy.
//
// Fix: collapse the selection to the END of the composer before EVERY chunk,
// then VERIFY the composer actually holds the whole prompt by re-reading the
// DOM. Bounded retry (never unbounded), and on ChatGPT a failure throws so the
// engine hops the lane instead of sending scrambled text to the model.
async function _collapseCaretToEnd(sels) {
    return page.evaluate((s) => {
        for (const sel of s) {
            const el = document.querySelector(sel);
            if (!el) continue;
            el.focus();
            if (el.value !== undefined) {           // <textarea>/<input>
                try { el.selectionStart = el.selectionEnd = el.value.length; } catch (e) {}
                return true;
            }
            const range = document.createRange();   // contenteditable
            range.selectNodeContents(el);
            range.collapse(false);                  // false = to the END
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
        }
        return false;
    }, sels);
}

async function _composerText(sels) {
    return page.evaluate((s) => {
        for (const sel of s) {
            const el = document.querySelector(sel);
            if (!el) continue;
            return (el.value !== undefined && el.value !== null)
                ? String(el.value) : (el.innerText || el.textContent || '');
        }
        return '';
    }, sels);
}

async function insertTextChunked(cdp, text, sels) {
    const CHUNK = parseInt(process.env.INSERT_CHUNK_CHARS || '1500', 10);
    if (text.length <= CHUNK) {
        await _collapseCaretToEnd(sels);
        await cdp.send('Input.insertText', { text });
        return;
    }
    for (let i = 0; i < text.length; i += CHUNK) {
        // Re-anchor before EVERY chunk: this is the whole fix. Without it a
        // ProseMirror re-render between chunks drops the next one mid-document.
        await _collapseCaretToEnd(sels);
        await cdp.send('Input.insertText', { text: text.slice(i, i + CHUNK) });
        await sleep(60);
    }
}

// Insert, then PROVE the composer holds the prompt. Returns the final length.
async function insertVerified(cdp, text, sels, { isChatGpt = false } = {}) {
    const MAX_TRIES = 3;                       // bounded — never a retry loop
    let lastLen = -1;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        await insertTextChunked(cdp, text, sels);
        await sleep(200);
        const got = await _composerText(sels);
        lastLen = got.length;
        // Compare on WHITESPACE-NORMALISED text. A contenteditable reports
        // innerText with its own block separators — ProseMirror adds one extra
        // newline per paragraph node, so a correct 16,780-char prompt reads
        // back as 17,011 chars (measured). Comparing raw text makes every long
        // multi-line prompt look corrupt. What actually matters is that the
        // CONTENT and its ORDER survived, so normalise runs of whitespace on
        // both sides, then check length-within-tolerance AND the prompt's own
        // tail — a scrambled insert moves the tail even when the length matches.
        const norm = (x) => x.replace(/\s+/g, ' ').trim();
        const nGot = norm(got);
        const nWant = norm(text);
        const tail = nWant.slice(-60);
        const lenOk = Math.abs(nGot.length - nWant.length) <= Math.max(32, nWant.length * 0.02);
        const tailOk = tail.length === 0 || nGot.endsWith(tail);
        if (lenOk && tailOk) {
            if (attempt > 1) console.log(`✅ composer verified on attempt ${attempt} (${got.length} chars)`);
            return got.length;
        }
        console.log(`⚠️ composer mismatch (attempt ${attempt}/${MAX_TRIES}): `
            + `want ${nWant.length} normalised chars ending ${JSON.stringify(tail.slice(-24))}, `
            + `got ${nGot.length} ending ${JSON.stringify(nGot.slice(-24))} `
            + `[lenOk=${lenOk} tailOk=${tailOk}]`);
        if (attempt < MAX_TRIES) {
            await clearComposerHard(cdp, sels);   // full reset, then retype
            await sleep(150);
        }
    }
    if (isChatGpt) {
        throw new Error(`Composer verification failed after ${MAX_TRIES} attempts `
            + `(want ${text.length} chars, got ${lastLen}) — refusing to send a scrambled prompt`);
    }
    // ★ A SHORT COMPOSER IS NOT A SCRAMBLED ONE, IT IS A TRUNCATED ONE — and sending it
    // anyway is how the model gets a prompt with the middle missing and no way to know.
    // Measured: 150,682 chars went in, the composer held 30,717, and the send proceeded
    // "unverified" — so the model worked from a prompt that silently lost 120K chars.
    //
    // A composer that holds CONSISTENTLY LESS than we sent (same short length on every
    // retry) means a length limit, not a race; a retry cannot fix it and neither can the
    // model. Refuse loudly instead, naming the number, so the caller shrinks the prompt.
    if (lastLen > 0 && lastLen < text.length * 0.9) {
        throw new Error(`prompt exceeds what this composer accepts: sent ${text.length} chars, `
            + `the composer kept ${lastLen}. Refusing to send a prompt with the middle missing — `
            + `shrink it (MAX_PROMPT_CHARS / the tool-result cap) or start a fresh context.`);
    }
    console.log(`⚠️ proceeding with unverified composer (${lastLen}/${text.length} chars)`);
    return lastLen;
}

// Hard clear: real CDP key events (Ctrl+A, Backspace) with an execCommand
// fallback, then confirm by re-reading the DOM rather than trusting the call.
async function clearComposerHard(cdp, sels) {
    try {
        await _collapseCaretToEnd(sels);
        for (const t of [
            { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
            { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
            { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
            { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
        ]) {
            await cdp.send('Input.dispatchKeyEvent', t);
        }
    } catch (e) {
        console.log('⚠️ key-event clear failed:', String(e).slice(0, 120));
    }
    await sleep(120);
    let left = (await _composerText(sels)).trim().length;
    if (left > 0) {
        // execCommand path (works on DeepSeek/NoteGPT where key events desync)
        await page.evaluate((s) => {
            for (const sel of s) {
                const el = document.querySelector(sel);
                if (!el) continue;
                el.focus();
                if (el.value !== undefined) { el.value = ''; }
                else {
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                }
                el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }));
                return;
            }
        }, sels);
        await sleep(120);
        left = (await _composerText(sels)).trim().length;
    }
    return left;
}

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

    // contenteditable: focus, clear, then insert the WHOLE text as a single
    // Input.insertText CDP command — newlines are inserted literally, never
    // synthesized into Enter keypresses (the keyboard.type() hazard).
    // 08-16 FIX: page.keyboard.sendCharacter() emits one insertText PER
    // CHARACTER — the ~190K-char audit digest = ~190K CDP round-trips, which
    // blew the 120s protocolTimeout on the Gemini lane ("Input.insertText timed
    // out"). A single command carries the whole prompt natively.
    await page.evaluate((sels) => {
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) { el.scrollIntoView({ block: 'center', inline: 'center' }); el.focus(); return; }
        }
    }, config.selectors.input);
    await sleep(400);
    // 09-13 (NoteGPT lane): Ctrl+A + Backspace on a contenteditable desyncs
    // Vue's v-model — measured live, after this clear the composer held 7983
    // chars while `button.bg-primary` stayed disabled:true, so every send
    // click was a no-op. Only clear when there is actually something to clear;
    // a fresh composer must be left untouched so the framework observes the
    // Input.insertText that follows.
    const alreadyEmpty = await page.evaluate((sels) => {
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const t = (el.value !== undefined && el.value) || el.innerText || el.textContent || '';
            return t.trim().length === 0;
        }
        return true;
    }, config.selectors.input);
    let inserted = false;
    if (!alreadyEmpty) {
        // 09-13: clear the composer with REAL key events, not execCommand.
        // execCommand('selectAll'/'delete') works on DeepSeek and ChatGPT but
        // does NOT clear Kimi's `.chat-input-editor` — measured live, its draft
        // survived a full page reload at 1787 chars, so every send appended
        // after it and the prompt was never the leading text. Ctrl+A + Backspace
        // dispatched through CDP (modifiers:2 = Ctrl) DID clear it (1811 -> 1).
        // Playwright's page.keyboard is unreliable on a CDP-attached page, so
        // drive the keys over the raw protocol.
        try {
            const cdp = await page.createCDPSession();
            for (const t of [
                { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
                { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
                { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
                { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
            ]) {
                await cdp.send('Input.dispatchKeyEvent', t);
            }
            // 09-13 (Kimi): insert the prompt in the SAME CDP session as the
            // clear. Kimi restores its saved per-conversation draft on the next
            // render, so clearing in one session and typing in another left a
            // ~150 ms window in which the 6811-char draft came back — every
            // send then appended after it (measured: composer 6812 chars, the
            // prompt never the leading text, gateway wedged to the hard cap).
            // Back-to-back in one session, the draft never gets the chance.
            // 09-14 (Bob: "chat gbt does work, ur just sending it trunacated
            // system prompts"): a single Input.insertText of a LONG prompt
            // killed the ChatGPT renderer mid-insert — measured
            // `TargetCloseError: Protocol error (Input.insertText): Target
            // closed` on an 8,023-char prompt, after which the composer held
            // only the prefix and the model answered the TRUNCATED contract
            // (`{"edits":[],"notes":"cannot`). Insert in bounded chunks so the
            // renderer never sees one oversized protocol frame.
            // 09-14 (worker): caret-anchored + VERIFIED. See insertVerified.
            await insertVerified(cdp, text, config.selectors.input,
                                 { isChatGpt: _isChatGptHost() });
            await cdp.detach();
            inserted = true;
        } catch (e) {
            console.log('⚠️ key-event clear failed, falling back to execCommand:', String(e).slice(0, 120));
            await page.evaluate((sels) => {
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    el.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                    return;
                }
            }, config.selectors.input);
        }
        await sleep(150);
    }
    if (!inserted) {
        // 09-14: same chunking as the primary path — this FALLBACK is the one
        // that was actually running (the key-event clear throws on ChatGPT, so
        // `inserted` stays false) and a single oversized insertText killed the
        // renderer mid-prompt, which is how the model ended up answering a
        // truncated contract.
        const cdp = await page.createCDPSession();
        // 09-14 (worker): this FALLBACK is the path that actually runs on
        // ChatGPT (the key-event clear throws there), so it gets the same
        // caret-anchored, verified insert.
        await insertVerified(cdp, text, config.selectors.input,
                             { isChatGpt: _isChatGptHost() });
        await cdp.detach();
    }
    // 09-13 (NoteGPT lane): CDP Input.insertText updates the DOM but does NOT
    // always reach a Vue/React v-model, so the SPA still believes the composer
    // is EMPTY — its send button stays disabled and every click is a no-op
    // (measured: 7983 chars in the composer, `button.bg-primary` disabled:true).
    // Dispatching a real input event makes the framework observe the text.
    await page.evaluate((sels) => {
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) continue;
            el.dispatchEvent(new InputEvent('input', {
                bubbles: true, cancelable: true, inputType: 'insertText', data: el.innerText || '',
            }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
    }, config.selectors.input);
    await sleep(200);
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
                    if (el) { el.scrollIntoView({ block: 'center', inline: 'center' }); el.focus(); return true; }
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
            //
            // 09-16: do NOT replace this click with Emulation.setFocusEmulationEnabled.
            // Tried it to stop the click raising the browser window; it makes the
            // PAGE believe it is focused but leaves the composer element unfocused,
            // so the Enter press lands nowhere, the prompt strands in the box and
            // every request burns the full timeout (verified live on gemini: text
            // still in the composer, only the PREVIOUS answer in the thread).
            // The editor reacts to real activation, not to hasFocus().
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
            if (quirk('enterSubmits', true)) {
                await page.keyboard.press('Enter');
                await sleep(1500);
            }
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
                            if (el) { el.scrollIntoView({ block: 'center', inline: 'center' }); return; }
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
                    // 09-13 (NoteGPT lane): its send button ignores a mouse
                    // click at the measured centre AND a `scrollIntoView` +
                    // mouse path, but a direct in-page `.click()` on the same
                    // element DOES submit (verified by hand: composer cleared,
                    // "Task completed" rendered). The gateway's mouse-first
                    // order therefore left the prompt sitting in the composer.
                    // SEND_INPAGE_ONLY skips the mouse click entirely.
                    if (quirk('sendInPageOnly', process.env.SEND_INPAGE_ONLY === 'true')) {
                        const clicked = await page.evaluate((sels) => {
                            for (const sel of sels) {
                                const el = document.querySelector(sel);
                                if (el && el.getBoundingClientRect().width > 0) { el.click(); return true; }
                            }
                            return false;
                        }, config.selectors.send);
                        if (!clicked) throw new Error('in-page send click found no button (SEND_INPAGE_ONLY)');
                        return;
                    }
                    // 09-12 (owner screenshot): the prompt was typed and the send
                    // button was never clicked. The button can be laid out
                    // OFF-VIEWPORT — measured live on the DeepSeek composer, a
                    // prompt sitting in the textarea with the send button at
                    // x = -14 (left of the viewport). `scrollIntoView` above now
                    // asks for inline centering, but a horizontal scroll does not
                    // always take; a mouse click at a negative x lands nowhere and
                    // the text just sits in the box. If the coordinates are still
                    // outside the viewport, dispatch the click in-page instead —
                    // it reaches the element regardless of layout.
                    // 09-13: a CDP-attached page (the ChatGPT lane connects to a
                    // raw Chrome over CDP_WS_URL) has no Playwright
                    // viewportSize(); calling it threw "page.viewportSize is not
                    // a function" and killed the send before the click. Read the
                    // viewport from the page itself, and treat "unknown" as
                    // in-view so we still take the normal mouse-click path.
                    let vp = { width: 0, height: 0 };
                    try {
                        vp = (typeof page.viewportSize === 'function' && page.viewportSize())
                            || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
                            || { width: 0, height: 0 };
                    } catch { /* fall through with 0x0 */ }
                    const inView = pos.x >= 0 && pos.y >= 0 &&
                                   pos.x <= vp.width && pos.y <= vp.height;
                    if (inView) {
                        await page.mouse.click(pos.x, pos.y);
                    } else {
                        console.log(`🖱 send button off-viewport (${Math.round(pos.x)},${Math.round(pos.y)}) — clicking in-page`);
                        const clicked = await page.evaluate((sels) => {
                            for (const sel of sels) {
                                const el = document.querySelector(sel);
                                if (el && el.getBoundingClientRect().width > 0) { el.click(); return true; }
                            }
                            return false;
                        }, config.selectors.send);
                        if (!clicked) throw new Error('send button could not be clicked (off-viewport)');
                    }
                    // 09-13 (owner: "chatgbt prompt was never sent"): the mouse
                    // click can land on a button that is visible and enabled and
                    // still not submit — measured on the ChatGPT lane, the button
                    // sat at (1414,461) inside a 1888px viewport, disabled=false,
                    // and the whole 17K-char prompt stayed in the composer with no
                    // assistant turn ever appearing. The in-page el.click() DID
                    // submit it. So verify the send actually took: if the composer
                    // still holds the prompt, dispatch the click on the element.
                    await sleep(1200);
                    const stillThere = await page.evaluate((sels) => {
                        for (const sel of sels) {
                            const el = document.querySelector(sel);
                            const t = el && ((el.value !== undefined && el.value) || el.innerText || el.textContent || '');
                            if (t && t.trim().length > 0) return true;
                        }
                        return false;
                    }, config.selectors.input);
                    if (stillThere) {
                        console.log('🖱 prompt still in composer after the click — clicking the send button in-page');
                        const clicked = await page.evaluate((sels) => {
                            for (const sel of sels) {
                                const el = document.querySelector(sel);
                                if (el && el.getBoundingClientRect().width > 0) { el.click(); return true; }
                            }
                            return false;
                        }, config.selectors.send);
                        if (!clicked) console.log('⚠️ in-page send click found no button — falling through to Enter');
                    }
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
async function snapshotChat(before = null) {
    // 09-16 (ChatGPT lane): `before` is the pre-send snapshot. With the
    // answerIdFloor quirk on, the rows it already listed are, by definition,
    // NOT this send's answer — see the priorIds filter below.
    const priorIds = (quirk('answerIdFloor', false) && before && Array.isArray(before.ids))
        ? before.ids
        : null;
    return page.evaluate((sels, skipEmptyRows, priorIds) => {
        // Strip the site's own chrome from a row's text. Gemini renders every reply
        // inside a row that ALSO carries a "Gemini said" header and, for a tool call,
        // a "JSON" code-block label. Measured live: a placeholder row holding ONLY the
        // header ("Gemini said", 11 chars) passed the raw-length emptiness test, became
        // the newest row, and then cleaned down to the EMPTY STRING — so waitForResponse
        // read "" for the whole grace window and threw "response is empty after 180s"
        // while the real answer (a complete run_bash tool call) sat in the row before it.
        // Emptiness must therefore be judged on the CLEANED text, not the raw text.
        const cleanRow = (raw) => String(raw || '')
            .replace(/^\s*Gemini said\s*\n*/gi, '')
            .replace(/\bGemini said\b\s*/gi, '')
            .replace(/^\s*JSON\s*\n+/gi, '')
            .replace(/^\s*(?:json|txt|text|python|bash|shell)\s*(?:Copy\s*)?(?:Download\s*)?\n+/gi, '')
            .trim();
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
                answerIndex: items.length - 1,
                matchTotal: items.length,
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
        let lastElMatchIndex = -1;    // ROW ordinal, not a raw node index (see below)
        let lastElRowOrdinal = 0;    // ordinal among KEPT rows (see the floor note)
        const seen = new Set();
        const ids = [];
        // 09-16: identity of a row, stable across re-renders. ChatGPT stamps a
        // server-side uuid on every turn (measured: 8/8 rows carried one).
        const prior = priorIds ? new Set(priorIds) : null;
        for (const s of sels) {
            for (const el of document.querySelectorAll(s)) {
                // If el is contained inside an already seen container, skip nested duplicate
                let isNested = false;
                for (const prev of seen) {
                    if (prev.contains(el)) { isNested = true; break; }
                }
                if (isNested) continue;

                // 09-16 STALE-ROW FIX: a webchat SPA keeps the DOM nodes of a
                // previous conversation mounted after you move to a new chat —
                // measured on Gemini, 11 leftover <model-response> nodes still
                // matched while the visible thread was empty. document order
                // then puts one of THOSE last, and the gateway returns a reply
                // from a conversation it is not even in (observed live: a
                // greeting answered with a paragraph from the previous chat).
                // Only a row the browser actually renders may be the answer.
                if (el.getClientRects().length === 0) continue;

                const t = (el.innerText || '').trim();
                const isUserRow = el.tagName === 'USER-QUERY'
                    || (el.getAttribute && el.getAttribute('data-message-author-role') === 'user')
                    || /^You have access to the tools below/.test(t)
                    || /### SYSTEM INSTRUCTION|### USER MESSAGE/.test(t);
                if (isUserRow) continue;

                n++;
                seen.add(el);
                const rowId = (el.getAttribute && el.getAttribute('data-message-id')) || '';
                // 09-16: only a row that ALREADY CARRIED AN ANSWER may seed priorIds.
                // Pushing the id of an EMPTY row reintroduces the exact trap the index
                // floor had, one layer down: ChatGPT keeps empty phantom assistant
                // rows in the DOM, and if this send's answer is delivered into a row
                // that was already there, that id is in priorIds and the REAL answer
                // is filtered out forever - observed as `Webchat response is empty
                // after 240s` while the tab held the reply. The stale-answer case is
                // untouched: the PREVIOUS answer row is non-empty, so its id is still
                // seeded and still rejected.
                if (rowId && t.length > 0) ids.push(rowId);
                // 09-16 STALE-ANSWER FIX (ChatGPT follow-up sends): ChatGPT mounts
                // the new assistant row EMPTY and leaves it empty for the whole
                // thinking window (measured on a 13,319-char send: 210s of
                // `<div aria-busy="true" class="result-streaming pulse"><span><pre></pre>`
                // with innerText.length === 0). skipEmptyRows then keeps `lastEl`
                // on the PREVIOUS answer, whose text never changes, so the wait
                // loop accepted it as complete and the API returned the previous
                // reply (measured: two different prompts, both "Response received
                // (8410 chars)"). A row that already existed before this send can
                // never be this send's answer — drop it by IDENTITY, not by index:
                // the row COUNT is not monotonic (measured 8 rows -> 9 after a
                // send that added 2), which is why the earlier index-floor attempt
                // rejected every row forever and returned nothing.
                if (prior && rowId && prior.has(rowId)) continue;
                // 09-13 (ChatGPT lane): ChatGPT leaves EMPTY phantom assistant
                // rows in the DOM (measured: 6 nodes, lens [22,4,54,0,0,0]).
                // Taking the last match unconditionally made `lastEl` an empty
                // node, so waitForResponse read "" for 12s and threw "response
                // is empty after 12s" while the real answer sat in an earlier
                // node. Only a text-bearing row may become the newest answer.
                if (skipEmptyRows) {
                    // Cleaned, not raw: a header-only row ("Gemini said") is empty
                    // for every purpose this function has.
                    if (cleanRow(t).length > 0) { lastEl = el; lastElMatchIndex = n; }
                } else {
                    lastEl = el; lastElMatchIndex = n;
                }
            }
        }
        const rawTxt = lastEl ? (lastEl.innerText || '').slice(0, 100000) : '';
        const txt = cleanRow(rawTxt);
        // answerIndex/matchTotal are the identity-free floor: a row whose ordinal is
        // below the pre-send matchTotal did NOT exist before this send, so it cannot be
        // this send's answer. Without it, a send whose new row is still EMPTY leaves
        // `text` pointing at the PREVIOUS answer, the stability test fires, and the API
        // returns the previous reply verbatim — measured here as a probe answered
        // "READY" (a stale turn's text) while the real reply was still generating.
        return { mode: 'count', count: n, ids, text: txt, answer: txt, answerIndex: lastElMatchIndex,
                 matchTotal: n, lastCls: lastEl ? (lastEl.className || '').toString() : '', body: document.body ? document.body.innerText || '' : '' };
    }, config.selectors.message, quirk('skipEmptyMessageRows', false), priorIds);
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
// ── Busy probe (09-22) ──────────────────────────────────────────────────────
// The in-page predicate behind isForeignBusy(). It lives at module scope so it
// can be unit-tested against a stub DOM without launching a browser — the
// phantom-stop defect below was invisible to every test that needed chrome.
//
// SIGNAL CLASSES, and why they are separated:
//
//   * STOP-CONTROL signals (aria-label / innerText / data-testid "stop").
//     A lane with `phantomStopButton` leaves its stop control mounted, visible
//     and unclickable AFTER the answer commits, so these cannot be trusted
//     there. They are the ONLY signals that quirk is about.
//
//   * ARIA-BUSY signals (an assistant row reporting `aria-busy="true"`).
//     ChatGPT's trusted in-flight signal; it reports the row's own state and
//     has nothing to do with the stop control, so it stays valid on every lane.
//
//   * EMPTY-MOUNTED-ROW (`emptyRowMeansBusy`). Some lanes mount the response
//     row for the send and fill it minutes later. That is a generation in
//     flight, not an aborted answer. Opt-in per mode, because a lane that
//     leaves EMPTY PHANTOM rows in the DOM (ChatGPT: measured 6 nodes,
//     lens [22,4,54,0,0,0]) would otherwise read busy forever.
function busyProbe(spec) {
    const { phantomStop = false } = spec || {};
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

    // ── Non-stop signals: evaluated on EVERY lane ───────────────────────────
    // 09-17 (Bob: "Chat gbt is likely fine, investigate" - HE WAS RIGHT):
    // ChatGPT generates with NO stop control in the DOM at all. Measured on the
    // live tab during a real generation:
    //   stop-button: false   data-testid stop-ish: none   aria-label stop: none
    //   assistant row aria-busy="true"  <- the ONLY signal, true for 360s
    // The row's own aria-busy is the signal to trust. It reports the ROW's
    // state and has nothing to do with the stop control, so `phantomStopButton`
    // must not disable it — the quirk is about stop controls lying, not about
    // the lane having no readable busy state.
    for (const r of document.querySelectorAll('[data-message-author-role="assistant"][aria-busy="true"]')) {
        if (isVisible(r)) return true;
    }
    for (const r of document.querySelectorAll('[data-message-author-role="assistant"]')) {
        if (r.querySelector('[aria-busy="true"]') && isVisible(r)) return true;
    }

    // ── Stop-control signals: skipped on a phantom-stop lane ────────────────
    // PHANTOM-STOP (gemini): Gemini leaves its "Stop response" control mounted,
    // visible, enabled and unclickable after the answer commits — verified live
    // (aria-label "Stop response", rects 1, display flex, opacity 1, persists
    // for minutes). Reading it as "cogitating" made the pre-send guard refuse
    // every follow-up AND made the accept gate never fire, so each send burned
    // the full timeout.
    if (phantomStop) return false;

    for (const el of document.querySelectorAll('[aria-label]')) {
        if (!stopish(el.getAttribute('aria-label'))) continue;
        if (isVisible(el)) return true;
    }
    for (const b of document.querySelectorAll('button')) {
        if (stopish(b.innerText) && isVisible(b)) return true;
    }
    // 09-13/09-14 (ChatGPT lane): the in-flight control is a data-testid, not an
    // aria-label, and is not always `stop-button` — a missed stop control made
    // `busy` read false, the empty grace expired mid-generation, and the send
    // threw "empty after 12s" while the tab held the finished answer.
    for (const el of document.querySelectorAll('[data-testid]')) {
        const tid = (el.getAttribute('data-testid') || '').toLowerCase();
        if (tid.includes('stop') && isVisible(el)) return true;
    }
    const sb = document.querySelector('[data-testid="stop-button"]');
    if (isVisible(sb)) return true;

    return false;
}

async function isForeignBusy() {
    try {
        return await page.evaluate(busyProbe, {
            phantomStop: quirk('phantomStopButton', false),
        });
    } catch { return false; }
}

// ── AUTO-CONTINUE (09-13) ───────────────────────────────────
// NOTE: only the button-label path is implemented. If a site renders the
// control as an icon with no text/aria-label, add its selector to
// config.selectors and extend the loop below.
// DeepSeek (and zh UIs generally) render a "Continue" / "继续" button when a
// generation is cut short — the server ends the stream mid-answer and the UI
// offers to resume it. Until now the harness read that as "generation
// finished", accepted the truncated text, and the caller got a half answer;
// a human had to click Continue by hand and the request never completed
// (owner's report from a user: "Deepseek times out all the time and I have to
// click continue").
// Click it and keep waiting — the answer is not finished, it is paused.
// Only a VISIBLE, ENABLED control whose text is exactly continue-ish counts;
// a substring match would hit prompt text (the gateway's own preamble
// mentions "continues", which is why this is anchored, not /continue/i).
// 09-14: DeepSeek renders a persistent "Continue" control that STAYS in the DOM
// after it is clicked. The caller loops on this function and extends its deadline
// on every hit, so a stuck Continue button produced a click every ~1s forever —
// measured 175 clicks in 20 min on ds-gw2 — and the send never terminated, which
// burned the engine's whole 400s lane budget and returned no edits. Bound it:
// click at most once per CONTINUE_COOLDOWN_MS and at most CONTINUE_MAX_CLICKS
// times per send, then report no-hit so the caller proceeds to accept/fail.
const CONTINUE_COOLDOWN_MS = Number(process.env.CONTINUE_COOLDOWN_MS || 8000);
const CONTINUE_MAX_CLICKS = Number(process.env.CONTINUE_MAX_CLICKS || 5);
let _continueClicks = 0;
let _continueLastAt = 0;

function resetContinueBudget() {
    _continueClicks = 0;
    _continueLastAt = 0;
}

async function clickContinueIfPresent() {
    if (_continueClicks >= CONTINUE_MAX_CLICKS) return false;
    if (Date.now() - _continueLastAt < CONTINUE_COOLDOWN_MS) return false;
    try {
        const hit = await page.evaluate(() => {
            const cont = (s) => {
                s = (s || '').trim().toLowerCase().replace(/[.。…\s]+$/, '');
                return s === 'continue' || s === 'continue generating'
                    || s === 'continue generation' || s === 'resume'
                    || s === '继续' || s === '继续生成' || s === '继续回答';
            };
            const isVisible = (el) => {
                if (!el) return false;
                if (el.disabled || el.getAttribute('aria-disabled') === 'true'
                    || el.getAttribute('disabled') !== null) return false;
                if (el.getAttribute('aria-hidden') === 'true') return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden'
                    || parseFloat(style.opacity || '1') === 0) return false;
                return el.offsetParent !== null || el.getClientRects().length > 0;
            };
            for (const el of document.querySelectorAll('button, [role="button"]')) {
                if ((cont(el.innerText) || cont(el.getAttribute('aria-label'))) && isVisible(el)) {
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                    el.click();
                    return (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 24);
                }
            }
            return null;
        });
        if (hit) {
            _continueClicks += 1;
            _continueLastAt = Date.now();
            console.log(`▶ generation was cut short — clicked "${hit}" and continuing `
                        + `(${_continueClicks}/${CONTINUE_MAX_CLICKS})`);
        }
        return !!hit;
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
            // `think` carries the model's PRIVATE THINKING (the
            // DeepThink reasoning streamed BEFORE the RESPONSE fragment is
            // declared, plus THINK fragment content) — readStreamedAnswer
            // accumulates it into window.__wsThinkBuf so it can be read back.
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

// Read + reset the page's accumulated THINK (reasoning) text for the exchange
// that just finished.
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
                    // The model's PRIVATE THINKING accumulates
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
// 09-16 (owner): "js have the timer stop once a first stream is detected."
//
// Progress clock. `_lastProgressAt` is stamped at the START of every send and again
// every time the wait loop sees the answer GROW. withAbsoluteDeadline below then
// measures SILENCE (`now - _lastProgressAt`), not elapsed time, so the moment a first
// stream is detected the clock stops running against the send and cannot kill it.
// A caller that makes no progress at all sees exactly the old behaviour: an absolute
// timeout of `ms`. Without this, HARD_CAP_MS guillotined a long generation the tab
// was still streaming - the timer kept running after the first token.
let _lastProgressAt = Date.now();
function markProgress() { _lastProgressAt = Date.now(); }

// be accepted as the response (DeepSeek cogitates for seconds before its
// answer replaces it as the last item).
// 09-15: the hard cap inside waitForResponse is only checked BETWEEN awaits, so a
// CDP read that never returns holds the send indefinitely - measured
// /health {"wedged":true,"outstandingMs":1532785}, a send stuck for 25 MINUTES with
// the finished answer sitting in the tab the whole time (the engine read every one
// of those as 'empty response after 180s'). Race the whole call against an absolute
// deadline so NOTHING inside it can outlive the budget, whichever await hangs.
// 09-16: that race is now an IDLE deadline - re-armed on every progress stamp - so it
// still catches a wedged send but never cuts one that is still producing.
function withAbsoluteDeadline(promise, ms, label) {
    let timer;
    const idleDeadline = new Promise((_, rej) => {
        const arm = () => {
            const idleFor = Date.now() - _lastProgressAt;
            if (idleFor >= ms) {
                rej(new Error(`${label} made no progress for ${ms}ms (idle deadline)`));
                return;
            }
            timer = setTimeout(arm, Math.max(250, Math.min(ms - idleFor, 15000)));
        };
        arm();
    });
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        idleDeadline,
    ]);
}

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
    //
    // 09-12: this was deadline + timeout*5. With TIMEOUT=600000 that is 600s +
    // 3000s = ONE HOUR, so a send whose reply never arrives wedged the gateway
    // for an hour (observed outstandingMs 601339, and the engine timing out at
    // its 420s lane budget every time). Cap the extension at one extra timeout
    // instead: a stream that is still producing output gets up to 2x the budget,
    // and one that is simply stuck fails fast so the caller can retry.
    // 09-12: allow the extension to be tuned. A genuinely stuck send must fail
    // fast so the engine can hop to another lane, instead of holding the whole
    // gateway for 2x the timeout (observed outstandingMs 360-373s repeatedly).
    const hardCapMs = parseInt(process.env.HARD_CAP_MS) || (deadline + config.timeout);
    const hardCap = Math.max(deadline, hardCapMs);
    // 09-16 (owner): "js have the timer stop once a first stream is detected."
    // Before the first stream the send is bounded by the absolute cap; once the
    // answer has CONTENT, activity extends the deadline with no cap at all and every
    // growth stamps the progress clock, so the outer idle deadline cannot fire
    // either. A send that never produces content keeps the old behaviour exactly.
    let sawContent = false;
    let _throttlePolls = 0; // 09-17: cadence for the page-throttle check below
    let _lastSeenLen = (before && typeof before.text === 'string') ? before.text.length : 0;
    // 09-18 OWNER RULE, enforced: "theres not supposed to be any limit on task
    // completion, only limits on last seen token stream." extendOnActivity() re-arms
    // the window on every growth and is UNBOUNDED once content is seen - which is
    // correct for a working task, but it also means a STUCK page that merely holds
    // text (e.g. the prompt echoed into a stale row) can hold the send forever: the
    // `while (Date.now() < deadline)` loop keeps being extended, so the process-level
    // cap never fires and the callers' budget becomes the only bound.
    // Measured 09-18: engine reported 14 `timeout after 480s` in 90 min while the
    // gateways logged ZERO `Timed out after` lines - i.e. the gateway never gave up,
    // the engine's per-lane budget did. Median DS send is 5s (p90 20-25s), so a send
    // with no growth for a whole extra idle window is stalled, not slow.
    let lastGrowthAt = Date.now();
    const extendOnActivity = () => {
        lastGrowthAt = Date.now();
        const ext = Math.max(deadline, Date.now() + config.timeout);
        deadline = sawContent ? ext : Math.min(hardCap, ext);
    };
    // Abort a stalled send instead of holding a worker until the caller's budget runs
    // out. Scoped to AFTER first content: the pre-content empty-row grace
    // (EMPTY_GRACE_MS) already covers the thinking window, and this must never
    // guillotine a slow-but-working generation.
    const idleAbortMs = Math.max(
        30000,
        parseInt(process.env.IDLE_ABORT_MS || '0', 10) || config.timeout);
    let lastLen = -1; // forces at least two polls before accepting
    let lastAnswerLen = -1; // same for the think-stripped answer text (08-12)
    let lastText = null; // previous poll's thread text, for activity detection
    let emptySince = 0; // how long the newest message element has been empty
    // Consecutive poll failures. Declared OUTSIDE the while loop on purpose: a
    // counter scoped inside it resets on every poll, so it can never reach the
    // threshold and the dead-renderer probe below would never run — which is
    // exactly the bug this counter exists to fix.
    let _pollFailures = 0;
    // ── 09-23b: BOUND EVERY POLL AWAIT ────────────────────────────────────────
    // The recovery below only runs when a poll THROWS. That was still not enough,
    // because a poll against a dead renderer does not throw promptly: `page.evaluate`
    // is bounded only by protocolTimeout (240000ms, set above), and each iteration
    // makes TWO such calls. So a corpse cost ~480s before the failure counter
    // incremented even once — measured: a send sat at outstandingMs 420542 with the
    // renderer dead and the counter still at 0. Racing each call against a short
    // deadline converts "hangs for the protocol timeout" into "fails in
    // POLL_BOUND_MS", which is what makes the existing recovery reachable in seconds
    // instead of after most of the 900s budget has already been spent.
    const POLL_BOUND_MS = Math.max(3000, parseInt(process.env.POLL_BOUND_MS || '20000', 10));
    const boundPoll = (promise, label, ms = POLL_BOUND_MS) => {
        let t;
        const bound = new Promise((_, rej) => {
            t = setTimeout(() => {
                const e = new Error(`poll "${label}" exceeded ${ms}ms — renderer unresponsive?`);
                e.pollTimeout = true;
                rej(e);
            }, ms);
        });
        // finally clears the timer on BOTH paths, so a fast success cannot leave a
        // live 20s timer behind. Promise.race keeps a handler on the original promise,
        // so a late rejection after the race settles is absorbed, not unhandled.
        return Promise.race([promise, bound]).finally(() => clearTimeout(t));
    };
    // Shared failure path for every poll await, so a hang in either one counts.
    // Returns to continue the loop; throws retryable once the renderer is proven dead.
    const handlePollFailure = async (e) => {
        _pollFailures += 1;
        const _msg = String(e && e.message).slice(0, 70);
        if (_pollFailures >= RENDERER_DEAD_AFTER) {
            const alive = await probeRendererAlive();
            if (!alive) {
                await dropDeadRenderer(`no renderer response after ${_pollFailures} poll failures: ${_msg}`);
                // Retryable: the next attempt runs the normal connect path, which
                // builds a fresh page. Tagged rather than thrown bare so the send
                // retry in server.js actually fires (it keys on e.retryable).
                const err = new Error(
                    'Webchat renderer died mid-generation (tab unresponsive; it has been closed so the retry gets a fresh page) — please resend'
                );
                err.retryable = true;
                err.rendererDead = true;
                throw err;
            }
            console.log(`⏳ ${_pollFailures} poll failures but the renderer answers — still generating, continuing`);
            // A renderer that ANSWERS is alive, even if the page is too busy to render
            // a row. Stamp the progress clock or the outer idle deadline counts this
            // as no-progress and kills a working send.
            markProgress();
            _pollFailures = 0;
        }
        console.log('⏳ poll evaluate failed (page busy?), retrying:', _msg);
    };
    while (Date.now() < deadline) {
        // 08-13: stream tee FIRST — the DOM may never render the answer in
        // this environment. found=true means loadend fired, so the body is
        // complete; return it without waiting on the UI.
        try {
            const tee = await boundPoll(readStreamedAnswer(teeStart), 'stream-tee');
            if (tee.found) {
                // 08-13 RATE-LIMIT FIX: the stream can end with a hint-error
                // (e.g. "Messages too frequent") — nothing else ever arrives.
                // Fail fast with the error text; a hung client retries, and
                // each retry re-hammers the same account limit.
                if (tee.error) throw streamError(tee.error);
                if (tee.text.trim().length > 0) return tee.text;
                if (tee.done) throw new Error('Webchat stream ended without content (error status in stream)');
            }
        } catch (e) {
            if (e.message && /stream ended without content|stream error/.test(e.message)) throw e;
            // A bounded-await timeout is a renderer signal, not a stream error — route
            // it through the shared handler so it counts toward recovery instead of
            // silently falling through and spending another full protocolTimeout.
            if (e.pollTimeout) await handlePollFailure(e);
            // otherwise (page busy / evaluate race) fall through to the DOM poll
        }
          let state;
          try {
              state = await boundPoll(snapshotChat(before), 'snapshot');
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
            //
            // 09-23: but a DEAD RENDERER throws the same shape and used to get the
            // same treatment, so a corpse was polled until the 900s idle deadline
            // while every chrome process idled at 0.0% CPU. A single failure is
            // still normal; repeated ones are not, so after RENDERER_DEAD_AFTER
            // consecutive failures a bare `1+1` decides which one this is.
            // 09-23b: shared with the stream-tee await, so a hang there counts too.
            await handlePollFailure(e);
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
        // 09-19 ECHO GUARD (the real cause of "deepseek wedged"): DeepSeek rotates
        // its row hashes, and the hash list above goes stale with every rotation -
        // when it did, the reader accepted the just-sent USER row as the answer.
        // Measured over 6h on the three ds gateways: of 57 stalls, 40 carried a
        // "partial answer" whose length was the PROMPT length +39 or +24 chars -
        // i.e. the prompt echoed back - and since an echoed prompt never grows, the
        // send sat to the idle abort and retried, which the engine saw as a 480-720s
        // wedge. DeepSeek had answered fine: `⏱ stall: no growth for 120s` on a row
        // that was never the answer at all.
        // The hash check cannot be trusted as the only gate, so ALSO reject a
        // candidate whose size IS the prompt's size: the assistant's reply is a
        // small edits-contract JSON, never a copy of a 300+-char prompt.
        const _ansLen = (state.answer || '').length;
        const _typedLen = typeof typedText === 'string' ? typedText.length : 0;
        const echoOfPrompt = _typedLen > 300 && _ansLen > 0 && Math.abs(_ansLen - _typedLen) < 150;
        const userRow = (state.lastCls || '').split(/\s+/).includes(USER_ROW_CLS)
            || (state.lastCls || '').split(/\s+/).includes('_81e7b5e')
            || echoOfPrompt
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
        // 09-22 STALE-ANSWER FLOOR (identity-free). `grew` alone is not enough when a
        // site mounts the new answer row EMPTY: the newest NON-EMPTY row is then the
        // PREVIOUS answer, the stability test sees unchanging text, and the API returns
        // the last turn's reply as if it were this one. Measured on Gemini: a probe
        // came back "READY" — a two-turns-old submit_answer — while the real reply was
        // still generating. The floor rejects any answer read from a row ordinal that
        // already existed in the pre-send snapshot. Opt-in (quirk `answerRowFloor`),
        // because a site whose rows recycle their ordinals would need the id-based
        // path instead; Gemini stamps no row ids, so ordinal is the only handle it has.
        const answerIsNewRow = !quirk('answerRowFloor', false)
            || !before
            || typeof before.matchTotal !== 'number'
            || typeof state.answerIndex !== 'number'
            || state.answerIndex < 0
            || state.answerIndex >= before.matchTotal;
        // Accept on the THINK-STRIPPED answer text going stable (08-12): the
        // raw text is reasoning-only during cogitation, and accepting raw-text
        // stability could return just the thinking block (which then failed
        // the tool-call parse → the double-rejections before every tool call).
        // `answer` is empty while the model cogitates, so this never accepts
        // a reasoning-only pause. Fallback (count mode / older builds): the
        // raw-text check.
        // 09-16 (owner): "js have the timer stop once a first stream is detected."
        // FIRST-STREAM DETECTION. Any GROWTH of the answer text past the pre-send
        // baseline means the model has started producing: latch sawContent (which
        // lifts the absolute cap for the rest of this send) and stamp the progress
        // clock (which re-arms the outer idle deadline). Deliberately keyed on TEXT
        // GROWTH, never on `busy` - a tab that is merely busy with no new text is not
        // a stream, and treating it as one is what let a wedged send run unbounded.
        const _tLen = (state && typeof state.text === 'string') ? state.text.length : 0;
        // 09-19: a USER row appearing is NOT the model streaming. `state.text` is the
        // raw last-row text, so the moment the just-sent prompt rendered it grew - and
        // latching sawContent on that growth made an UNANSWERED send look like one that
        // had started, so the idle abort then fired on a send the model had not begun.
        // Measured after the echo guard landed: 2 of 9 stalls were still prompt+39, i.e.
        // the guard stopped the echo being RETURNED as the answer but the send still
        // stalled on it. Only assistant-row growth counts as the first stream; a user row
        // leaves the progress clock alone so the EMPTY grace (not the idle abort) ends a
        // send the model never started.
        if (_tLen > _lastSeenLen) {
            _lastSeenLen = _tLen;
            if (!userRow) { sawContent = true; markProgress(); }
        }
        const busy = state.mode === 'vl' ? await isGenerating() : await isForeignBusy();
        // 09-17 (BOB): a PAGE-rendered throttle must ABORT the send instead of sitting
        // until the hard cap. DeepSeek renders "Messages too frequent. Try again later."
        // in the page footer, NOT in the reply, so RATE_LIMIT.isRateLimitText() never saw
        // it: the gateway kept sending to a throttled account, every send timed out, and
        // that hammering is exactly what risks a ban. Measured live on :9229 - 3 sends /
        // 0 responses while the notice sat above the composer.
        // Check the TAIL of body.innerText (where the notice renders) and throw its own
        // words - server.js's catch already recognises that text and turns it into the
        // 900s account cooldown, so the engine hops instead of hammering.
        // Deliberately NOT a body-wide pattern: the sidebar conversation title
        // "Fix rate limiter test" matched a wide regex and produced a false positive.
        // Only checked while no content has arrived yet - a throttled send never streams,
        // and innerText on a huge page is not free.
        if (!sawContent && (++_throttlePolls % 4) === 0) {
            const notice = await page.evaluate(() => {
                const t = (document.body.innerText || '').slice(-400);
                const m = t.match(/Messages too frequent[^\n]*|Try again later[^\n]*/i);
                return m ? m[0].trim() : '';
            }).catch(() => '');
            if (notice) throw new Error('Webchat rate limit: ' + notice);
        }
        // 09-13: DeepSeek pauses a long generation behind a "Continue" button
        // instead of finishing it. Resume the generation instead of accepting
        // the truncated text as the answer.
        if (quirk('autoContinueButton', true) && await clickContinueIfPresent()) {
            extendOnActivity();
            await sleep(1200);
            continue;
        }
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
            if (grew && answerIsNewRow && answerText.length > 0 && answerText !== '…' && !/^\.{2,4}$/.test(answerText) && answerText.length === lastAnswerLen && !busy) {
                const teeNow = await readStreamedAnswer(teeStart);
                if (teeNow.found && teeNow.text.trim().length > 0) return teeNow.text;
                if (!looksLikeTruncatedAnswer(answerText)) return state.answer;
                // else: mid-stream fragment — do NOT accept; keep polling
            }
        } else if ((grew || state.text !== before.text) && answerIsNewRow && state.text.length > 0 && state.text.length === lastLen) {
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
                if (!toolDone) { await sleep(1500); continue; }
            }
            return state.text;
        }
        if (grew && state.text.length === 0) {
            // a new message element exists but has no text yet — if the chat
            // reports the response was stopped, that's a hard failure
            // 09-13 (ChatGPT lane): ChatGPT mounts the assistant row the moment
            // it starts and leaves it EMPTY while the model thinks, which can
            // exceed 12s. An in-flight generation is not an empty answer, so a
            // live stop control resets the grace instead of counting against it.
            //
            // 09-22 (owner: the Gemini lane) — ON A PHANTOM-STOP LANE THERE IS
            // NO LIVE STOP CONTROL TO READ, so `busy` stays false for the WHOLE
            // thinking window and the grace counted that window as silence.
            // Measured: a send on Gemini held `raw=11 clean=0` for 270s and the
            // content arrived at t+285s, against a 600s grace — and the gateway
            // log records the outcome as
            //   "Webchat response is empty after 600s — stopped or aborted by the UI"
            // while the page text it quotes proves the model was working
            // ("Running… Reading…").
            //
            // The missing signal is the row itself: we reached this branch
            // because `grew` is true, i.e. a message row APPEARED that was not
            // in the pre-send snapshot, and its cleaned text is still empty.
            // A row mounted for this send that has no text yet is a generation
            // in flight, not an aborted answer.
            //
            // It lives HERE and not in isForeignBusy() on purpose: `grew` is
            // computed against the pre-send snapshot, so the signal is provably
            // THIS send's row. isForeignBusy() is also called by the PRE-SEND
            // guard with no snapshot, and a lane that leaves an empty trailing
            // row would then read as permanently generating and refuse every
            // follow-up. Scoped here, the worst case is a slower grace on one
            // send, never a lane that cannot be used.
            const inFlight = busy || quirk('emptyMountedRowMeansBusy', false);
            if (inFlight) emptySince = 0; else emptySince += 1500;
            if (state.body.includes('You stopped this response')) {
                throw new Error('Webchat response was stopped (Stop button pressed while generating)');
            }
            // 09-14 (ChatGPT): ChatGPT mounts the assistant row EMPTY the
            // moment it starts and can stay empty well past 12s before the
            // first token lands (measured: gateway threw at 20.2s, the tab
            // then held a complete 103-char edits JSON). A mounted-but-empty
            // newest row on chatgpt is a generation in flight, not an aborted
            // answer — give it a chatgpt-sized grace instead of the generic
            // 12s so a slow-but-real answer is never discarded.
            // 09-15: this was a flat `chatgpt ? 60s : 12s`, and it is the real
            // reason both thinking-model lanes kept "failing (timeout)". Measured
            // live with Playwright: an answer to an 18.7K prompt rendered in the
            // tab at ~103s, but the 60s grace had already thrown
            //   Webchat response is empty after 60s — stopped or aborted by the UI
            // BEFORE the model produced its first token. freebuff was worse: not a
            // chatgpt.com host, so it got the 12s default while GLM thinks for
            // 4-5 minutes. The grace must outlast TIME-TO-FIRST-TOKEN, not the
            // whole answer. Per-lane override via EMPTY_GRACE_MS, else by host.
            const host = new URL(config.webchatUrl).host;
            const emptyGraceOverride = parseInt(process.env.EMPTY_GRACE_MS || '0', 10);
            // config.emptyGraceMs is the configured value (env or harness.config.json,
            // per-mode overridable); the host table below is only the fallback for a
            // lane nobody has configured. Gemini needs a real entry: it is a thinking
            // model, and the old 12s default threw while the tab was mid-generation.
            const emptyGraceMs = emptyGraceOverride > 0
                ? emptyGraceOverride
                : (config.emptyGraceMs > 0 ? config.emptyGraceMs
                    : host.includes('chatgpt') ? 180000
                    : host.includes('freebuff') ? 240000
                    // measured 2026-09-22: >250s to first token while Gemini read a
                    // brief and planned; a complete tool call was on screen when the
                    // old value threw.
                    : host.includes('gemini') ? 600000
                    : 60000);
            if (emptySince > emptyGraceMs) {
                // 09-16: carry the PAGE TEXT into the error. The account can be
                // throttled - DeepSeek then renders "Messages too frequent, try again
                // later" ON THE PAGE and never produces a reply, so the sender times
                // out at the full hard cap (measured: outstandingMs 463719, repeated
                // 330s timeouts) while the harness sees nothing to inspect. The
                // rate-limit detector in server.js keys on the MESSAGE
                // (RATE_LIMIT.isRateLimitText(error.message), server.js:1737), so
                // quoting the page here is what lets it recognise the throttle, cool
                // the account for 900s, and stop burning a full budget per send.
                // Measured: ds-gw(9229) and ds-gw2(9225) both read tooFrequent=true
                // while ds-gw4(9227) read false - and only ds-gw4 was answering.
                throw new Error(`Webchat response is empty after ${emptyGraceMs / 1000}s — stopped or aborted by the UI.`
                    + ` Page said: ${String(state.body || state.text || '').replace(/\s+/g, ' ').slice(0, 400)}`);
            }
        } else if (!sawContent) {
            // 09-19 DEAD-SEND FIX: a send where NO new message row ever appears
            // (`grew` false forever) used to fall into `else { emptySince = 0 }`,
            // so the emptiness timer NEVER accumulated and the send ran to the
            // full TIMEOUT — measured on :8080/:8081 as a 403s attempt that
            // produced nothing at all, then a browser reconnect, then a retry
            // that streamed 20,692 chars and stalled 120s more. The engine saw
            // the whole ~525s chain and called it a timeout. DeepSeek answers in
            // a 5s median, so 400s of silence is a dead send, not a slow one:
            // it must abort on the SAME empty grace (and carry the page text,
            // so the rate-limit detector can recognise a rendered throttle).
            emptySince += 1500;
            const _graceMs = parseInt(process.env.EMPTY_GRACE_MS || '0', 10);
            const _host = new URL(config.webchatUrl).host;
            const _limit = _graceMs > 0 ? _graceMs
                : _host.includes('chatgpt') ? 180000
                : _host.includes('freebuff') ? 240000
                : _host.includes('gemini') ? 600000
                : 60000;
            if (emptySince > _limit) {
                throw new Error(`Webchat response is empty after ${_limit / 1000}s — no new message row appeared (the send never committed or the model never started).`
                    + ` Page said: ${String(state.body || state.text || '').replace(/\s+/g, ' ').slice(0, 400)}`);
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
            extendOnActivity();
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
            extendOnActivity();
        }
        if (sawContent && Date.now() - lastGrowthAt > idleAbortMs) {
            // 09-19: record the STATE at the stall, not just the timeout. Without it a stalled
            // send could not be told apart from one that never produced a first token, so the
            // cause could only be guessed at - three theories were tested that way and all
            // three failed their controls. These two numbers settle it on the next stall.
            const _partial = String(state.answer || state.text || '').trim();
            console.warn(`⏱ stall: no growth for ${Math.round((Date.now() - lastGrowthAt) / 1000)}s`
                + ` — partial answer=${_partial.length} chars, sawContent=${sawContent}`);
            const _stallErr = new Error(`Webchat stalled: no new output for ${Math.round(idleAbortMs / 1000)}s ` +
                `(last seen token stream, per the owner's rule) — aborting so the caller can retry`);
            // A stall is precisely the case the caller's retry exists for, so tag the CLASS of
            // failure. server.js keys on this flag instead of on the wording above - a reworded
            // message must never be able to silently disable the retry again.
            _stallErr.retryable = true;
            _stallErr.partialAnswerChars = _partial.length;
            throw _stallErr;
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
    const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('cdp poll timeout')), ms)),
    ]);
    // Seed the progress baseline from the CURRENT answer length. lastAnswerLen is
    // -1 here (the main loop only sets it for 'vl' mode), so `grewNow` would be
    // true for any non-empty answer and the loop extended to the full hard cap
    // regardless — the stuck-send guard was a no-op (observed outstandingMs 383s).
    // 09-15: `withTimeout` is defined below, so THIS call had no deadline at all.
    // Measured: the chatgpt gateway wedged for 51 MINUTES
    // (`outstandingMs 3100549` against a 310s cap) — the cap is only checked
    // between awaits inside the loop below, so a CDP read that never returns on a
    // dead browser held the send indefinitely and, because sends are serialized,
    // took the whole lane down. Every pre-loop CDP call now has a deadline.
    let seedFailed = false;
    try {
        const seed = await withTimeout(snapshotChat(before), 20000);
        lastAnswerLen = (seed.answer || '').length;
    } catch {
        seedFailed = true;   // dead browser — the caller must heal, not wait
    }
    // 09-14: the hard cap was only checked BETWEEN awaits, so a CDP call that never
    // returns held the send forever — measured outstandingMs 511s against a 240s
    // cap, and because sends are serialized that wedged the whole lane and the
    // engine's batch with it. Race each poll against a deadline so the cap is
    // actually enforceable: on a timeout the loop simply re-checks Date.now().
    // 09-15: before entering the long rescue wait, check whether the tab is dead
    // rather than slow. A silent tab with no stop control will never produce
    // anything; healing it here returns the lane to service instead of burning
    // the full hard cap and cooling the lane behind it.
    let healedForDeadTab = false;
    {
        // `lastSendAt` lives in server.js, NOT here — referencing it was a bug.
        const generating = await isTabGenerating();
        // 09-15: this condition was DEAD CODE. lastAnswerLen is seeded to the
        // current answer length a few lines above, so on any thread that already
        // has messages it is >= 0 and the heal never ran — which is why the lane
        // could sit wedged for 51 minutes. A dead browser (the seed TIMED OUT or
        // an explicit not-generating tab with no baseline) must heal.
        if (generating === false && (lastAnswerLen < 0 || seedFailed)) {
            healedForDeadTab = await selfHealDeadTab(
                seedFailed ? 'CDP read timed out — browser unresponsive'
                           : 'no stream, no stop control');
        }
    }
    while (Date.now() < hardCap) {
        try {
            const tee = await withTimeout(readStreamedAnswer(teeStart), 20000);
            if (tee.found && tee.text.trim().length > 0) {
                console.log('⏱ timeout — rescuing the answer from the stream tee');
                return tee.text;
            }
            const last = await snapshotChat(before);
            // 08-13: never rescue while a generation is still running — the
            // newest row may be a stale previous answer or a stream fragment
            // (observed: the 20197-char gemini request rescued a 22-char row).
            // 09-12: only extend while the tab is actually PRODUCING new text.
            // isGenerating() alone stays true on a wedged tab, so the loop used
            // to hold the send for the full hard cap (~480s) with nothing
            // arriving — and because sends are serialized, that blocked the lane
            // for 8 minutes at a time (observed outstandingMs 429-474s, repeatedly,
            // while the engine's own lane budget is 280s). Track progress instead.
            const busyNow = state.mode === 'vl' ? await isGenerating() : await isForeignBusy();
            if (quirk('autoContinueButton', true) && await clickContinueIfPresent()) {
                await sleep(1500);
                continue;
            }
            const grewNow = (last.answer || '').length > lastAnswerLen;
            if (busyNow && grewNow) {
                lastAnswerLen = (last.answer || '').length;
                console.log('⏱ still generating past the deadline — extending (bounded by hard cap)');
                await sleep(1500);
                continue;
            }
            if (busyNow && !grewNow) {
                console.log('⏱ tab reports busy but produced no new text — giving up (stuck send)');
                break;
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
// 09-14 (owner): Freebuff pins its reasoning-effort menu to "Low" so the
// thinking model (GLM 5.3 Flash) doesn't spend 4-5 min reasoning per reply.
// The Radix popover does NOT open from an in-page el.click() (probed: the
// [role=menuitemradio] nodes stay empty), so drive REAL CDP mouse events at
// the measured coordinates — the same trick that makes the Kimi composer clear.
async function setReasoningEffortLow() {
    try {
        const cdp = await page.createCDPSession();
        const clickAt = async (x, y) => {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        };
        const btnPos = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')]
                .find((b) => (b.getAttribute('aria-label') || '').includes('reasoning effort'));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!btnPos) return;
        await clickAt(btnPos.x, btnPos.y);
        await sleep(1500);
        let lowPos = await page.evaluate(() => {
            const item = [...document.querySelectorAll('[role=menuitemradio]')]
                .find((e) => (e.innerText || '').includes('Low'));
            if (!item) return null;
            const r = item.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!lowPos) {
            // the popover can lag behind a fast click — reopen once and retry
            await clickAt(btnPos.x, btnPos.y);
            await sleep(1500);
            lowPos = await page.evaluate(() => {
                const item = [...document.querySelectorAll('[role=menuitemradio]')]
                    .find((e) => (e.innerText || '').includes('Low'));
                if (!item) return null;
                const r = item.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            });
        }
        if (!lowPos) { console.warn('⚠️ freebuff Low menu item not found after retry'); return; }
        await clickAt(lowPos.x, lowPos.y);
        await sleep(500);
        console.log('🎚️ freebuff reasoning effort -> Low');
    } catch (e) {
        console.warn('⚠️ set reasoning effort Low failed:', e.message);
    }
}

// ── open a fresh chat by PRESSING the site's New-chat control ───────────────
// Navigating to the chat root is NOT equivalent. Gemini redirects /app back to the
// last conversation (verified: the URL stayed /app/<thread> and the old thread's
// rows were still rendered), so a goto-based reset reuses the old thread while
// claiming to have opened a new one - and that history then poisons both the
// model's context and the DOM read.
//
// Returns true only if a control was found AND clicked. The caller falls back to
// navigation when this returns false, so a webchat with no known selector still
// resets (imperfectly) rather than dead-ending.
// ── resolve the live target page, re-picking it if the cached one is gone ────
// `page` is a module-level cache, and the stale-session refresh tears the CDP
// connection down and rebuilds it between sends. During that window the cached
// reference is detached, so any code that trusts it NPEs ("Cannot read properties
// of null (reading 'goto')") or silently skips its work — measured live: /newchat
// reported "no New-chat control found" because `page` was null, then threw on the
// navigation fallback, so the thread was NEVER reset and every "fresh" chat kept
// the previous conversation's context.
//
// Every path that is about to touch the page should call this rather than reading
// `page` directly. Returns null only when there is genuinely no browser or no
// matching tab, and never throws.
async function resolveTargetPage() {
    try {
        if (page && !page.isClosed()) return page;
    } catch { /* detached - fall through and re-pick */ }
    if (!browser) return null;
    try {
        const pages = await browser.pages();
        const match = (p) => {
            try {
                return config.tabUrlSubstring
                    ? p.url().includes(config.tabUrlSubstring)
                    : p.url().startsWith(new URL(config.webchatUrl).origin);
            } catch { return false; }
        };
        const found = pages.find((p) => !p.isClosed() && match(p));
        if (found) { page = found; return page; }
        // No matching tab: open one rather than failing the whole reset.
        const fresh = await safeNewPage();
        await fresh.goto(config.webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(() => { /* the caller's own waits will surface a real problem */ });
        page = fresh;
        return page;
    } catch {
        return null;
    }
}

async function clickNewChatControl() {
    const sels = (config.selectors && config.selectors.newChat) || [];
    if (!sels.length) return false;
    // Never trust the cached reference here: this runs immediately after a CDP
    // reconnect, which is exactly when the cache goes stale.
    const pg = await resolveTargetPage();
    if (!pg) { console.log('   ↳ new-chat: no live page'); return false; }

    // LOCATE the control entirely inside the page, then click the one node the page
    // itself named. Two reasons this is not a puppeteer handle loop:
    //   1. `boundingBox()` HANGS on a detached or unpainted node — measured live, the
    //      first of two matches for Gemini's sparkle button never returned, so
    //      /newchat hung forever and every thread reset silently did nothing while
    //      the request sat open. In-page DOM work cannot hang that way.
    //   2. A site can render the control twice (Gemini matches
    //      [data-test-id="side-nav-sparkle-button"] twice) and the first is not always
    //      the painted one. Choosing by measured geometry in the page picks the real
    //      one, where page.$() would take the hidden copy.
    const pick = await pg.evaluate((selectors) => {
        for (let si = 0; si < selectors.length; si++) {
            let nodes;
            try { nodes = [...document.querySelectorAll(selectors[si])]; } catch { continue; }
            for (let ni = 0; ni < nodes.length; ni++) {
                const el = nodes[ni];
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { si, ni, text: el.innerText || el.getAttribute('aria-label') || '' };
            }
        }
        // Last resort: a control whose label says "new chat".
        const all = [...document.querySelectorAll('a,button,[role="button"],[data-test-id]')];
        for (let ni = 0; ni < all.length; ni++) {
            const el = all[ni];
            const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim();
            if (/^new chat$/i.test(t)) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { si: -1, ni, text: t };
            }
        }
        return null;
    }, sels).catch((e) => { console.log(`   ↳ new-chat: locate failed (${String(e.message).slice(0, 60)})`); return null; });

    if (!pick) {
        console.log('   ↳ new-chat: no visible New-chat control on the page');
        return false;
    }

    // Click by COORDINATES rather than by handle. Puppeteer's element click waits for
    // the node to be stable and can block on the same detached handle that made
    // boundingBox hang; a coordinate click has nothing to wait on. It is also the
    // interaction that actually works on these SPAs — a DOM .click() often does not
    // fire the framework's handler.
    const box = await pg.evaluate((sel) => {
        const nodes = [...document.querySelectorAll(sel)];
        for (const el of nodes) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
        }
        return null;
    }, pick.si >= 0 ? sels[pick.si] : 'a,button,[role="button"],[data-test-id]')
        .catch(() => null);

    if (box) {
        await pg.mouse.click(box.x, box.y).catch(() => {});
        console.log(`🆕 clicked the New-chat control (${String(pick.text).slice(0, 40) || sels[pick.si]?.slice(0, 40)})`);
        return true;
    }

    // Geometry was unreadable at click time: fall back to a plain DOM click.
    await pg.evaluate((selectors) => {
        for (let si = 0; si < selectors.length; si++) {
            let nodes;
            try { nodes = [...document.querySelectorAll(selectors[si])]; } catch { continue; }
            for (const el of nodes) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { el.click(); return; }
            }
        }
    }, sels).catch(() => {});
    console.log('🆕 clicked a New-chat control (DOM fallback)');
    return true;
}



// How many conversation turns are on the page right now?
//
// The reset below MUST be verified with this rather than assumed from a successful
// click. Measured: on Gemini, /newchat clicked the sparkle control, slept, and
// reported ok:true while the thread still held 5 user and 5 assistant rows and 42KB
// of prior context — every reset silently did nothing. Seeding a task into that
// thread is how a plan job ends up answering a prompt from a conversation that has
// nothing to do with it.
//
// Counts ROWS, not elements: Gemini renders a user row and a model row per turn, and
// the sites differ on which wrapper they use, so a "no turns" result is the only
// thing that means "fresh thread" across all of them.
async function conversationRowCount() {
    const pg = await resolveTargetPage();
    if (!pg) return null;
    const sel = (config.selectors && config.selectors.message) || '';
    const out = await pg.evaluate((messageSel) => {
        // User rows are site-specific and there is no single selector for them, so
        // count the things that only exist in a conversation: the message blocks plus
        // the known user-row elements.
        const parts = [];
        if (messageSel) {
            try { parts.push(...document.querySelectorAll(messageSel)); } catch { /* ignore a bad selector */ }
        }
        try { parts.push(...document.querySelectorAll('user-query')); } catch { /* gemini */ }
        try {
            parts.push(...document.querySelectorAll('[class*="ds-virtual-list"] > *'));
        } catch { /* deepseek virtualised list */ }
        // Count only VISIBLE nodes: a hidden template or a cached pane is not a turn.
        return parts.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }).length;
    }, sel).catch(() => null);
    return typeof out === 'number' ? out : null;
}

async function openNewChat() {
    // Fresh CDP session like every send (stale-session refresh).
    await initBrowser({ reconnect: true });
    // Re-pick the pinned tab (the old thread's tab gets navigated away — the
    // conversation stays safe server-side).
    if (!page && config.cdpWsUrl) {
        const pages = await browser.pages();
        const _match = (p) => (config.tabUrlSubstring
            ? p.url().includes(config.tabUrlSubstring)
            : p.url().startsWith(new URL(config.webchatUrl).origin));
        page = pages.find(_match);
        // 09-18 SURPLUS-TAB SWEEP. A SECOND page matching the lane's substring is a
        // documented silent lane-killer: selectors come from pages.find() = the FIRST
        // match, so the gateway can attach to a stale corpse while the good tab sits
        // unused. Measured here: every DS chrome accumulated an old conversation plus a
        // fresh /a/chat/new, and the gateway on :8080 - whose chrome held TWO matching
        // pages - was the one burning 5 x 480s (40 worker-minutes) while its sibling
        // :8083 answered 42/42 with zero timeouts.
        // Prune in the one place the gateway already enumerates pages, so the
        // accumulation self-heals on the next reset instead of needing a manual sweep.
        // Only OTHER matching pages are closed - never the one just chosen, never a
        // non-matching tab the user may have open.
        try {
            if (page) {
                for (const _sp of pages.filter((p) => p !== page && _match(p))) {
                    try {
                        await _sp.close();
                        console.log('🧹 closed a surplus matching tab:', _sp.url().slice(0, 60));
                    } catch { /* already gone - harmless */ }
                }
            }
        } catch { /* pruning is best-effort, never block the attach */ }
        if (!page) {
            page = await safeNewPage();
            await page.goto(config.webchatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
    }
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
    // PRESS the site's own New-chat control. A goto is not a reset on these SPAs:
    // Gemini sends /app back to the last conversation, so the "fresh" thread still
    // held the previous history. Navigation is the fallback only.
    const _clicked = await clickNewChatControl();
    if (_clicked) {
        await sleep(2500);      // let the SPA swap the thread and settle the composer
        await waitForChatInput();
    } else {
        console.log('⚠️ no New-chat control found — falling back to navigation');
        const pg = await resolveTargetPage();
        if (!pg) throw new Error('no live page to open a new chat in (browser/tab unavailable)');
        await pg.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForChatInput();
        await sleep(2500); // let the SPA settle the composer
    }

    // ---- PROVE the thread actually reset ------------------------------------
    // A click that found its control is not a click that worked, and reporting a
    // fresh thread over a stale one is the failure this harness keeps paying for:
    // the next prompt lands in a conversation full of unrelated history. Measured
    // on Gemini - the sparkle control was found and clicked, ok:true was returned,
    // and the thread still held 5 turns and 42KB of prior context.
    let rows = await conversationRowCount();
    if (rows !== null && rows > 0) {
        console.log(`[reset] new chat still shows ${rows} row(s) - forcing navigation to clear it`);
        const pg2 = await resolveTargetPage();
        if (pg2) {
            await pg2.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await waitForChatInput();
            await sleep(2500);
        }
        rows = await conversationRowCount();
    }
    if (rows !== null && rows > 0) {
        // Say so rather than return normally: returning is what made /newchat
        // report ok:true over a thread it never touched.
        const err = new Error(`thread did not reset - ${rows} row(s) still present after click and navigation`);
        err.resetFailed = true;
        err.remainingRows = rows;
        throw err;
    }
    // Distinguish "measured and empty" from "could not measure". Collapsing the two
    // would let an unmeasurable page report a verified reset, which is the same class
    // of lie this whole check exists to remove.
    console.log(rows === null
        ? '[reset] thread state UNKNOWN (could not read the conversation) - not verified'
        : '[reset] thread verified empty');
    // 08-14 (user rule): mode is locked at thread creation — select EXPERT
    // on the fresh new-chat composer BEFORE the first message creates the
    // thread (instant threads can never become expert afterwards).
    if (new URL(config.webchatUrl).host.includes('deepseek')) {
        // 09-17: mode is LOCKED at thread creation and "instant threads can never become
        // expert afterwards" (see the handoff note below). Measured ~30 sends/hour landing
        // on INSTANT threads because the selection silently failed and we sent anyway.
        // So: if the first attempt fails, open one more fresh chat and try again - bounded
        // to a single retry, never a loop.
        let _expert = await selectExpertMode();
        if (!_expert) {
            console.log('🔁 expert select failed — one fresh-chat retry');
            await page.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await waitForChatInput();
            await sleep(2500);
            _expert = await selectExpertMode();
            console.log(_expert
                ? '🧠 expert mode recovered on the retry'
                : '⚠ expert mode still not available after one retry — sending on this thread');
        }
        await sleep(500);
    }
    // 09-14 (owner): Freebuff's reasoning-effort defaults to "Max (model default)"
    // on every new chat, which makes GLM 5.3 Flash think 4-5 min per reply. Pin
    // it to "Low" so the lane answers fast instead of cooking the timeout.
    if (new URL(config.webchatUrl).host.includes('freebuff')) {
        await setReasoningEffortLow();
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
        reply = await withAbsoluteDeadline(
            waitForResponse(before, text),
            Math.max(60000, parseInt(process.env.HARD_CAP_MS) || (config.timeout || 300000)) + 15000,
            'handoff waitForResponse');
    } catch (e) {
        // The thread exists the moment the message lands; a timed-out first
        // reply (long cogitation) must not abort the swap.
        console.log('⚠️ new-chat first reply timed out:', String(e.message).slice(0, 80));
    }
    const url = page.url();
    // Confirm a real conversation, not the bare chat root. The shape is PER MODE: this
    // was hardcoded to DeepSeek's /a/chat/s/ and therefore threw on every other host -
    // on Gemini a fresh thread is /app/<hex>, so /handoff reported failure after it had
    // already created and seeded the thread, and the gateway's own context handoff was
    // broken there too. A mode with no known shape is judged by URL depth rather than
    // refused, because refusing on an unknown shape is exactly what broke Gemini.
    const _pattern = config.threadPattern;
    let _ok;
    if (_pattern) {
        _ok = new RegExp(_pattern).test(url);
    } else {
        try {
            const _root = new URL(config.webchatUrl).pathname.replace(/\/+$/, '');
            const _now = new URL(url).pathname.replace(/\/+$/, '');
            _ok = _now.length > _root.length;
        } catch { _ok = true; }
    }
    if (!_ok) {
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
    // PASSTHROUGH_FORMAT: the caller supplied a complete contract (the oculus
    // step engine's {"edits":[...]}). This builder must add NOTHING — it used to
    // prepend the tool schema and append the REMINDER demanding a fenced
    // tool-call JSON or submit_answer, a competing schema stacked on the
    // caller's. Verified live: the composer carried exactly that block while the
    // caller's contract was supposed to be the only instruction.
    if (config.passthroughFormat) return userPrompt;

    let fullPrompt = '';

    if (toolDefinitions && toolDefinitions.length > 0) {
        let section =
            'You have access to the tools below. Every reply is exactly ONE fenced tool call:\n' +
            '```json\n{"tool":"<name>","params":{...}}\n```\n' +
            'You may put ONE short 💬 line before the fence — it is shown to the user. Anything longer, or any ' +
            'reply with no tool call at all, is rejected and sent back to you.\n' +
            'The fence is MANDATORY: without it this chat renders your backticks as formatting and corrupts the JSON.\n' +
            'Use a real tool to perform work when the task needs it — you judge whether it does. When the task is ' +
            'complete (or it was a simple question needing no tools), submit your final answer via submit_answer:\n' +
            '```json\n{"tool":"submit_answer","params":{"text":"..."}}\n```\n\n';

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
    // AND follow-ups) — the model's habit is to pause after tool work and write
    // a progress report, which the middle-of-prompt rules don't kill.
    fullPrompt += 'REMINDER: your reply must contain exactly one fenced tool call ' +
        '(```json {"tool":"<name>","params":{...}} ```), optionally preceded by ONE short 💬 line. ' +
        'A reply with no tool call — including a progress report, a summary of what you did, or a list of ' +
        '"next steps" — is rejected. Finish the task with a fenced ' +
        '```json {"tool":"submit_answer","params":{"text":"..."}} ```.\n';
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
    browserAlive,
    markShuttingDown,
    connectToWebchat,
    sendPrompt,
    closeBrowser,
    getPage: () => page,
    probePage,
    // Window state, exported so the CLI (`webchat window`) and window.js share ONE
    // implementation instead of each inventing its own idea of where the window is.
    getWindowState,
    setWindowState,
    setRequestToggles,
    carryContextToNewChat,
    WINDOW_STATES,
    // Browser discovery, exported so window.js attaches to the SAME browser the
    // harness is using instead of probing its own idea of the port order.
    findRunningBrowserWs,
    cdpProbeOrder,
    cdpPortIsExplicit,
    // Exported for the retry-classification test. Pure (text in, Error out), so it can
    // be exercised without a browser — and it must be the SHIPPED function, because a
    // test that re-implements the regex proves only that the regex was copied.
    streamError,
    // Exported for the busy-signal regression tests. It is pure (DOM in, bool
    // out), so it can be exercised without a browser — which is what would have
    // caught the phantom-stop short-circuit.
    busyProbe,
    // Dead-renderer handling, exported so the classifier is testable without a
    // browser — the whole bug was a message that matched nothing, and a test on
    // the real failure string is what keeps it matched.
    isRendererTimeoutError,
    probeRendererAlive,
    dropDeadRenderer,
    buildFullPrompt,
    openNewChat,
    sendFirstMessage,
    openNewChatAndSeed,
    getReqBodyChars,
    getAndClearThinkBuf,
    resetTeeForHandoff,
    takeThreadSwap,
    // Exported for the multi-webchat test. Pure and network-free, so the probe ORDER
    // can be asserted directly — the bug it guards is attaching to the wrong gate's
    // browser, which produces a working gateway answering as the wrong account.
    cdpProbeOrder,
    cdpPortIsExplicit,
};
