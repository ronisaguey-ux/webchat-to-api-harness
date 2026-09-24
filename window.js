#!/usr/bin/env node
/**
 * window.js — raise, minimise or query the harness browser window.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The browser runs HEADED on purpose (a real headed session keeps the login, and
 * headless is a fingerprint tell), so it has a real window. Historically that
 * window kept jumping onto the owner's screen mid-send.
 *
 * The cause was NOT that the window lacked a guard. It was that every new page was
 * created with CDP `Target.createTarget {background:false}`, which ACTIVATES the
 * tab — and activating a tab inside a minimised window makes Chrome restore and
 * raise that window. Fixed at the source in browser.js (safeNewPage passes
 * `background:true`). Chrome no longer raises itself, so:
 *
 *     minimise it  -> it stays minimised
 *     maximise it  -> it stays maximised
 *
 * No guard, no polling, nothing racing you. This command is only for when YOU want
 * to move the window deliberately.
 *
 * ── WHY IT IS A NODE SCRIPT AND NOT A SHELL SCRIPT ─────────────────────────
 * It drives Chrome over CDP (`Browser.getWindowForTarget` / `Browser.setWindowBounds`),
 * which Chrome implements on Windows, macOS AND Linux. The old minimise-guard used
 * `xdotool`, which exists only on X11 — so Windows users had no window control at
 * all. This works everywhere the harness itself works.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *     node window.js status                 # what state is it in?
 *     node window.js raise                  # bring it up (use this to sign in)
 *     node window.js drop                   # minimise it, and it stays down
 *     node window.js maximize               # maximise it, and it stays up
 *     node window.js normal                 # same as raise
 *
 *   Also reachable as:   webchat window raise
 *   Exit codes: 0 ok · 1 no browser attached · 2 bad usage
 */

'use strict';

let browserLib;
try {
    browserLib = require('./browser');
} catch (e) {
    console.error(`window.js: cannot load ./browser (${e.message})`);
    console.error('Run `npm install` in the repo first.');
    process.exit(1);
}

const { findRunningBrowserWs } = browserLib;

const ACTIONS = {
    status: 'status',
    raise: 'normal',
    show: 'normal',
    up: 'normal',
    open: 'normal',
    normal: 'normal',
    drop: 'minimized',
    hide: 'minimized',
    down: 'minimized',
    minimize: 'minimized',
    minimized: 'minimized',
    maximize: 'maximized',
    maximized: 'maximized',
};

const action = String(process.argv[2] || 'status').trim().toLowerCase();

if (action === '-h' || action === '--help' || action === 'help') {
    console.log(`usage: node window.js <status|raise|drop|maximize|normal>`);
    process.exit(0);
}
if (!(action in ACTIONS)) {
    console.error(`window.js: unknown action '${action}'`);
    console.error(`  want one of: ${Object.keys(ACTIONS).join(' | ')}`);
    process.exit(2);
}

/** Attach to the browser the harness is already using. Never launches one. */
async function attach() {
    const ws = await findRunningBrowserWs();
    if (!ws) {
        console.error('window.js: no running harness browser found.');
        console.error('  Start one first:  webchat connect    (or run `./start.sh`)');
        process.exit(1);
    }
    const puppeteer = require('puppeteer');
    return puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 20000 });
}

/** The window's own target — a page, not a service worker or devtools target. */
async function windowSession(browser) {
    const pages = (await browser.pages()).filter((p) => !(typeof p.isClosed === 'function' && p.isClosed()));
    if (!pages.length) throw new Error('the browser has no page open');
    const session = await pages[0].createCDPSession();
    const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
    return { session, windowId, bounds: bounds || {} };
}

(async () => {
    const browser = await attach();
    try {
        const { session, windowId, bounds } = await windowSession(browser);
        const current = bounds.windowState || 'normal';

        if (ACTIONS[action] === 'status') {
            console.log(`window ${windowId}: ${current}`);
            if (bounds.width) console.log(`  ${bounds.width}x${bounds.height} at ${bounds.left},${bounds.top}`);
            const guard = browserLib.WINDOW_STATES.includes(current) ? '' : ' (unrecognised)';
            console.log(`  guard: none — the browser is not auto-minimised${guard}`);
            await session.detach().catch(() => {});
            process.exit(0);
        }

        const want = ACTIONS[action];
        // CDP refuses to jump straight from minimized (or fullscreen) to maximized:
        //   "To maximize a minimized or fullscreen window, restore it to normal
        //    state first."
        // So route through normal. Without this, `window.js maximize` on a minimised
        // browser — the common case, since that is how it sits — errors out.
        if ((want === 'maximized' || want === 'fullscreen') && (current === 'minimized' || current === 'fullscreen')) {
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        }
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: want } });

        // An explicit raise should also come to the FRONT; setWindowBounds alone only
        // un-minimises. Bringing to front is correct precisely because the user asked.
        if (want === 'normal' || want === 'maximized') {
            try { await session.send('Page.bringToFront'); } catch (_) { /* not fatal */ }
        }
        await session.detach().catch(() => {});
        console.log(`window ${windowId}: ${current} -> ${want}`);
        process.exit(0);
    } catch (e) {
        console.error(`window.js: ${e.message}`);
        process.exit(1);
    } finally {
        // Detach only — the browser belongs to the harness, not to this command.
        try { browser.disconnect(); } catch (_) { /* already gone */ }
    }
})();
