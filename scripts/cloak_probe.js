// CloakBrowser probe — does the stealth engine get past Google's challenge
// with the gateway's existing .cookies.json login? Read-only diagnostic.
// Usage: node scripts/cloak_probe.js  (cwd = webchat-api)
import fs from 'fs';
const { launch } = await import('cloakbrowser');

(async () => {
    const cookies = JSON.parse(fs.readFileSync('.cookies.json', 'utf-8'));
    const browser = await launch({
        headless: true,
        humanize: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle', timeout: 90000 });
    await new Promise(r => setTimeout(r, 15000));
    const state = await page.evaluate(() => ({
        url: location.href,
        hasInput: !!document.querySelector('rich-textarea, [contenteditable="true"]'),
        bodyText: (document.body.innerText || '').slice(0, 200),
        frames: [...document.querySelectorAll('iframe')].map(f => (f.src || f.id || '').slice(0, 80)).filter(Boolean).slice(0, 8),
    }));
    console.log(JSON.stringify(state, null, 2));
    await page.screenshot({ path: '/tmp/cloak_gemini.png' });
    console.log('screenshot: /tmp/cloak_gemini.png');
    await browser.close();
    if (state.hasInput) { console.log('VERDICT: SPA LOADED — gateway driver swap viable'); process.exit(0); }
    console.log('VERDICT: no input box — challenge/login page');
    process.exit(2);
})().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
