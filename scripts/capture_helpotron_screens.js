#!/usr/bin/env node
/* Full-site screenshot capture for helpotron (localhost:5173).
 *
 * The app is state-driven (no URL routing) — this drives the real nav
 * via click-through, exactly like a user. Captures every navigable view
 * at desktop + mobile widths, full-page, then zips the lot.
 *
 * Nav robustness: sidebar buttons expose aria-label={item.label}; nav items
 * live in collapsible groups (group headers carry aria-expanded). When a
 * label isn't found the group is expanded first, then re-tried. Falls back
 * to exact-textContent match.
 *
 * Usage: node scripts/capture_helpotron_screens.js [outdir] [zipname]
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const WEBCHAT_API = '/home/roni/Roni_Workspace/webchat-api';
const puppeteer = require(path.join(WEBCHAT_API, 'node_modules', 'puppeteer'));
const CHROME = '/opt/google/chrome/chrome';
const SITE = 'http://localhost:5173';

const OUTDIR = process.argv[2] || '/tmp/helpotron_screens';
const ZIPNAME = process.argv[3] || 'helpotron_screens_8_23.zip';
const ZIP_PATH = `/home/roni/Roni_Workspace/audits_plans/backups/${ZIPNAME}`;

// Every navigable view + its sidebar label + parent group (from AppShell NAV_TREE)
const VIEWS = [
  { key: 'overview', label: 'Today', group: 'HOME' },
  { key: 'activity', label: 'Activity', group: 'HOME' },
  { key: 'agent', label: 'My Agent', group: 'WORKSPACE' },
  { key: 'history', label: 'Assignments', group: 'WORKSPACE' },
  { key: 'study', label: 'Study Tools', group: 'WORKSPACE' },
  { key: 'library', label: 'Library', group: 'WORKSPACE' },
  { key: 'insights', label: 'Insights', group: 'INTELLIGENCE' },
  { key: 'credits', label: 'Credits', group: 'ACCOUNT' },
  { key: 'settings', label: 'Settings', group: 'ACCOUNT' },
  { key: 'admin', label: 'Control Center', group: 'ADMIN' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Click a nav button; return 'ok' | 'expanded:<group>' (needs retry) | 'missing' */
async function clickNav(page, view) {
  return await page.evaluate(({ label, group }) => {
    const click = (el) => { el.click(); return 'ok'; };
    // 1. aria-label exact match (sidebar buttons carry it even when icon-only)
    const byLabel = [...document.querySelectorAll('button[aria-label]')]
      .find((b) => b.getAttribute('aria-label') === label);
    if (byLabel) return click(byLabel);
    // 2. expand the item's group header (aria-expanded marks group toggles)
    if (group) {
      const header = [...document.querySelectorAll('button[aria-expanded]')]
        .find((b) => (b.textContent || '').toUpperCase().includes(group));
      if (header) { header.click(); return 'expanded:' + group; }
    }
    // 3. exact textContent fallback
    const byText = [...document.querySelectorAll('button, [role="button"], a')]
      .find((el) => (el.textContent || '').trim() === label);
    if (byText) return click(byText);
    return 'missing';
  }, view);
}

/* Ensure the sidebar is in its expanded (labeled) state. */
async function ensureSidebar(page) {
  await page.evaluate(() => {
    const expand = document.querySelector('button[aria-label="Expand sidebar"]');
    if (expand) expand.click();
  });
  await sleep(600);
}

async function capture(page, view, width, dir) {
  let res = await clickNav(page, view);
  if (res.startsWith('expanded:')) {
    await sleep(700); // let the group open
    res = await clickNav(page, view);
  }
  if (res === 'missing') console.log(`  !! could not navigate to "${view.label}"`);
  await sleep(2500); // let the view render
  const file = path.join(dir, `${String(width)}_${view.key}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ok ${view.key} (${width})${res !== 'ok' ? ` [${res}]` : ''}`);
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`capturing ${VIEWS.length} views at ${SITE} -> ${OUTDIR}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  for (const width of [1440, 390]) {
    const dir = path.join(OUTDIR, String(width));
    fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.goto(SITE, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(3000);
    await ensureSidebar(page);
    console.log(`--- ${width}px ---`);
    for (const v of VIEWS) {
      await capture(page, v, width, dir);
    }
    await page.close();
  }

  await browser.close();

  // Zip it
  execSync(`cd ${OUTDIR} && zip -qr ${ZIP_PATH} .`);
  const size = fs.statSync(ZIP_PATH).size;
  const count = fs.readdirSync(OUTDIR).length;
  console.log(`\nZIP: ${ZIP_PATH} (${(size / 1024 / 1024).toFixed(1)}MB, ${count} dirs)`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
