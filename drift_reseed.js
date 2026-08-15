// drift_reseed.js — main-side reseed after a VALID drift verdict (owner 08-15).
// Flow (owner design): task → detector flags drift in thinking → PAUSE + report
// to main → main adjudicates → VALID: run this script, then re-fire the task
// via 8080 with the reframe banner; the gateway re-pins the new thread
// (threadSwapSeen/takeThreadSwap) and the loop continues seamlessly.
//
// Usage: node drift_reseed.js [pinned-thread-url] [brief-file]
//   1. Stops the in-flight generation (STOP control) if one is visible.
//   2. Opens a fresh chat via the harness's own openNewChatAndSeed — EXPERT
//      mode locked at creation (selectExpertMode, DeepThink-only verified).
//   3. Seeds the sanitized brief as the first message (creates the thread).
//   4. Prints the new thread URL for the re-fire.
const fs = require('fs');
const browserMod = require('/home/roni/Roni_Workspace/webchat-api/browser.js');
const configMod = require('/home/roni/Roni_Workspace/webchat-api/config.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_URL = process.env.WEBCHAT_URL || 'https://chat.deepseek.com/a/chat/s/e480da5e-5904-4d25-8040-41ac1dd1c8d6';
const DEFAULT_BRIEF = process.env.DRIFT_BRIEF_FILE || '/home/roni/Roni_Workspace/audits_plans/sanitized_expert_brief.md';

(async () => {
  const threadUrl = process.argv[2] || DEFAULT_URL;
  const briefFile = process.argv[3] || DEFAULT_BRIEF;
  const brief = fs.readFileSync(briefFile, 'utf-8');

  // point the harness config at the pinned thread so openNewChat navigates
  // deepseek's /a/chat root (new-chat composer) instead of the thread itself
  const m = threadUrl.match(/\/a\/chat\/s\/([0-9a-f-]+)/);
  if (m) {
    configMod.webchatUrl = threadUrl;
    configMod.tabUrlSubstring = m[1];
  }

  await browserMod.initBrowser({ reconnect: true }); // shared connect path
  await browserMod.connectToWebchat(threadUrl); // bind page by tabUrlSubstring
  const page = browserMod.getPage();

  // 1) STOP an in-flight generation, if visible (we WANT this stop — the
  // never-click-STOP guard applies to normal flow, not to a drift abort).
  const stop = await page.evaluate(() => {
    // deepseek stop control: aria-label Stop / stop icon, square-ish
    const cands = [...document.querySelectorAll('button, [role="button"]')].filter((el) => {
      const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      const r = el.getBoundingClientRect();
      return /stop|停止/.test(t) && r.width > 0 && r.width < 120;
    });
    const el = cands[cands.length - 1];
    if (el) { el.click(); return true; }
    return false;
  });
  console.log('STOP CLICKED: ' + stop);
  await sleep(3000);

  // 2+3) fresh expert chat seeded with the sanitized brief
  const result = await browserMod.openNewChatAndSeed(brief);
  console.log('SEEDED: ' + JSON.stringify(result));

  // 4) the new thread URL
  console.log('NEW_THREAD_URL: ' + (browserMod.getPage() ? browserMod.getPage().url() : 'UNKNOWN'));
  process.exit(0);
})().catch((e) => { console.error('RESEED_FAILED: ' + (e.stack || e)); process.exit(1); });
