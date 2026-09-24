// Durable GUI-browser tab-size watcher (2026-08-13, v2)
// Fixes the 1/4-screen bug: GUI Chrome tabs render at 800x600 in a 1920x1080
// window. Every 4s, re-apply Emulation.setDeviceMetricsOverride to any tab
// whose layout viewport is < 1800px. Survives tab reloads/new tabs.
//
// v2: PERSISTENT connection — never disconnect. v1 created/destroyed a
// puppeteer connection each iteration; the detach cycle reset the very
// overrides it had just applied (observed: pins reverted within 4s).
//
// Launch: cd /home/roni/Roni_Workspace/webchat-api && setsid nohup node pin_watcher.js >> /tmp/pin_watcher.log 2>&1 &
const puppeteer = require('puppeteer');

const GUI_PORT = 9223;
const W = 1920, H = 1034;

let browser = null;

async function connect() {
  try {
    browser = await puppeteer.connect({browserURL: `http://127.0.0.1:${GUI_PORT}`, defaultViewport: null});
    console.log(`${new Date().toISOString()} connected`);
  } catch (e) {
    console.log(`${new Date().toISOString()} connect failed: ${String(e.message).slice(0, 80)}`);
    browser = null;
  }
}

async function pinLoop() {
  if (!browser) { await connect(); return; }
  let pages;
  try {
    pages = await browser.pages();
  } catch (e) {
    console.log(`${new Date().toISOString()} pages() failed, reconnecting: ${String(e.message).slice(0, 60)}`);
    browser = null;
    return;
  }
  for (const p of pages) {
    try {
      const url = p.url();
      if (!url.startsWith('http')) continue;
      const iw = await p.evaluate(() => innerWidth);
      if (iw < 1800) {
        const cdp = await p.target().createCDPSession();
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: W, height: H, deviceScaleFactor: 1, mobile: false,
        });
        console.log(`${new Date().toISOString()} PINNED ${url.slice(0, 70)} (was ${iw}px)`);
      }
    } catch (e) { /* page mid-navigation or detached — skip */ }
  }
}

connect().then(() => console.log(`${new Date().toISOString()} pin watcher v2 started (9223, ${W}x${H})`));
setInterval(pinLoop, 4000);
