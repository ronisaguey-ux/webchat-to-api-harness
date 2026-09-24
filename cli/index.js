'use strict';
//
// index.js — the interactive `webchat` CLI.
//
// The flow, in the owner's words: run `webchat`, click through the settings and
// gates, launch the browser, log in, mark it connected, then from a NEW terminal
// run `webchat start` to bring up the harness and whatever IDE is wired to it.
//
// Three design notes worth keeping:
//
//   * The config CLI is NOT the parent of the browser or the gateway. Both are
//     spawned detached with a pidfile (daemon.js), because the user's next step
//     happens in a different terminal.
//   * Every screen returns through one of three doors: a value, BACK (Esc), or
//     QuitError (Ctrl-C). Nothing is written until the user confirms.
//   * The CLI never claims a setting took effect when an env var shadows it.
//     That is the `shadowedBy` branch — the reason this layer exists at all.

const path = require('path');
const fs = require('fs');
const A = require('./ansi');
const S = require('./settings');
const D = require('./daemon');
const G = require('./gates');
const H = require('./harnesses');
const LC = require('./launchconfig');
const screensGates = require('./screens-gates');

let SHOW_ADVANCED = false;

// The gates/harnesses/launch screens live in their own file; this wires the shared
// helpers they need. Built once, lazily, because `state`/`rowsOf` are declared below.
let G_S = null;
function gatesScreens() {
    if (!G_S) {
        G_S = screensGates.build({
            A, D, G, H, LC,
            header, shortHome, panel,
            state, rowsOf,
            saveSetting: (p, v) => S.saveSetting(p, v),
        });
    }
    return G_S;
}

// ── Shared helpers ─────────────────────────────────────────────────────────
function state() {
    const { raw, file, missing, error } = S.loadRaw();
    const dotenv = S.loadDotenv();
    return { raw, file, missing, error, dotenv: dotenv.vars, dotenvFile: dotenv.file };
}

function rowsOf(st) {
    return S.resolveAll(st.raw, process.env, st.dotenv);
}

function header(bits) {
    const w = A.termWidth();
    A.line(A.dim('─'.repeat(w)));
    A.line(`  ${A.bold(A.cyan('webchat'))} ${A.dim('·')} ${bits.join(` ${A.dim('·')} `)}`);
    A.line(A.dim('─'.repeat(w)));
}

function shortHome(p) {
    return String(p).replace(process.env.HOME || '\u0000', '~');
}

async function panel(title, bodyLines, backLabel = 'Back') {
    A.clear();
    for (const l of A.boxLines(title, bodyLines, { width: A.termWidth() })) A.line(l);
    A.newline();
    return A.menu([{ label: backLabel, value: 'back' }], { title: '' });
}

// ── Dashboard ──────────────────────────────────────────────────────────────
// ── Helpers for the live view ──────────────────────────────────────────────
function fmtDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtClock(d) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// A bar, so pacing is readable at a glance instead of needing arithmetic.
function bar(fraction, width = 16) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    const filled = Math.round(f * width);
    return A.cyan('█'.repeat(filled)) + A.gray('░'.repeat(width - filled));
}

// The landing screen AND the live view — one screen, not two commands.
//
// Every number here comes from the gateway's own /metrics, because that is the only
// honest source: it reports what the process did, not what the CLI believes. A
// gateway that is not running is shown as stopped rather than as zeroes, since
// "0 sends" and "no gateway" mean very different things when a run looks stuck.
//
// The poll is ASYNC and the render is SYNC. That split matters: the menu owns stdin
// and must never block on a network call, so a background interval refreshes a
// snapshot and the tick only redraws from it.
async function screenDashboard() {
    const st = state();
    const rows = rowsOf(st);
    const get = (p) => rows.find((r) => r.setting.path === p);
    const shadowed = rows.filter((r) => r.shadowedBy);

    const host = get('server.host').value || '127.0.0.1';
    const port = get('server.port').value || 8080;
    const cdpPort = Number(process.env.CDP_PORT || 9225);

    // Dashboard preferences, all optional with sensible defaults so a user who never
    // opens Settings still gets a good screen.
    const refreshS = Number(get('dashboard.autoRefreshSeconds').value);
    const showPacing = get('dashboard.showPacing').value !== false;
    const showThrottle = get('dashboard.showThrottle').value !== false;
    const showRetries = get('dashboard.showRetries').value === true;
    const showTools = get('dashboard.showTools').value === true;

    const snap = {
        gw: { up: false }, metrics: null, cdp: { up: false, pages: [] },
        at: new Date(), err: null,
    };

    async function refresh() {
        try {
            const gw = await D.probeGateway(host, port);
            snap.gw = gw;
            if (gw.up) {
                const r = await D.httpGet(`http://${host}:${port}/metrics`, 2000);
                if (r.ok) {
                    try { snap.metrics = JSON.parse(r.body); } catch { snap.metrics = null; }
                } else snap.metrics = null;
            } else snap.metrics = null;
            snap.cdp = await D.cdpAlive(cdpPort);
            snap.at = new Date();
            snap.err = null;
        } catch (e) {
            snap.err = e && e.message ? e.message : String(e);
        }
    }
    await refresh();

    // Render one frame from the snapshot. Pure and synchronous.
    function frame() {
        const out = [];
        out.push(A.bold('webchat') + A.gray(`  ${get('webchat.mode').value || '(no webchat chosen)'}`));
        out.push(A.gray(`  ${shortHome(st.file)}`));

        const m = snap.metrics;
        const conn = D.readConnection();

        const body = [];
        body.push(`${A.dim('gateway')}    ${snap.gw.up
            ? A.green(`up  http://${host}:${port}`)
            : A.gray('stopped')}${m && m.uptimeMs != null ? A.gray(`   up ${fmtDuration(m.uptimeMs)}`) : ''}`);
        body.push(`${A.dim('browser')}    ${snap.cdp.up
            ? A.green(`running, CDP :${cdpPort}`) + A.gray(`  ${snap.cdp.pages.length} tab(s)`)
            : A.gray('not running')}`);
        body.push(`${A.dim('webchat')}    ${A.bold(m ? m.model || '—' : (get('webchat.mode').value || '—'))}`
            + (conn ? A.green('   connected') : A.gray('   not connected')));

        if (!snap.gw.up) {
            body.push('');
            body.push(A.gray('Start it to see live numbers and to run an agent.'));
        } else if (!m) {
            body.push('');
            body.push(A.yellow('The gateway is up but /metrics did not answer.'));
            body.push(A.gray('An older build may be running — restart it from the menu below.'));
        } else {
            body.push('');
            body.push(`${A.dim('state')}      ${m.requestInFlight
                ? A.yellow(`busy — ${fmtDuration(m.inFlightMs)} into this send`)
                : A.green('idle')}`);
            body.push(`${A.dim('sends')}      ${m.sendCount}${m.lastSendAgoMs != null
                ? A.gray(`   last ${fmtDuration(m.lastSendAgoMs)} ago`) : A.gray('   none yet')}`);

            // Latency, from a rolling window of real sends. The average is the one
            // that answers "has this lane got slower?", which a single last-send
            // figure cannot — one stall and one fast reply look the same.
            const lat = m.latency || {};
            if (lat.samples > 0) {
                body.push(`${A.dim('latency')}    ${A.gray('avg')} ${fmtDuration(lat.avgMs)}`
                    + A.gray(`   median ${fmtDuration(lat.p50Ms)}   last ${fmtDuration(lat.lastMs)}`));
                body.push(`           ${A.gray(`over the last ${lat.samples} send(s)   range ${fmtDuration(lat.minMs)}–${fmtDuration(lat.maxMs)}`)}`);
            } else {
                body.push(`${A.dim('latency')}    ${A.gray('no sends yet this run')}`);
            }

            const p = m.pacing || {};
            if (showPacing) {
                if (!p.applies) {
                    // Say WHY there is no wait, so "no pacing" does not read as
                    // "pacing is broken" on a webchat that never had any.
                    body.push(`${A.dim('pacing')}     ${A.green('none')}  ${A.gray(p.reason || 'no pacing on this webchat')}`);
                } else if (p.min != null) {
                    const lo = p.min, elapsed = p.elapsedSinceLastSend;
                    const ready = elapsed == null || elapsed >= lo;
                    body.push(`${A.dim('pacing')}     ${lo / 1000}–${p.max / 1000}s between sends`
                        + (elapsed != null ? `   ${ready ? A.green('ready') : A.yellow('waiting')}` : ''));
                    if (elapsed != null && !ready) {
                        body.push(`           ${bar(elapsed / lo)}  ${A.gray(`next send in ~${fmtDuration(Math.max(0, lo - elapsed))}`)}`);
                    }
                }
            }

            const rl = m.rateLimit || {};
            if (showThrottle) {
                if (rl.coolingDown) {
                    body.push(`${A.dim('throttled')}   ${A.red('cooling down')}  ${A.gray(`${fmtDuration(rl.cooldownRemainingMs)} left, then sends resume`)}`);
                } else if (rl.enabled) {
                    body.push(`${A.dim('throttled')}   ${A.green('no backoff active')}`);
                }
            }
            if (showRetries) body.push(`${A.dim('retries')}    ${m.sendRetriesLeft} left for the current send`);
            if (showTools) body.push(`${A.dim('tools')}      ${m.tools} exposed to the model`);
        }

        if (shadowed.length) {
            body.push('');
            body.push(A.yellow(`⚠ ${shadowed.length} setting(s) come from an environment variable,`));
            body.push(A.gray('  which overrides the config file.'));
        }
        if (st.error) body.push('', A.red(`config parse error: ${st.error.message}`));
        if (snap.err) body.push('', A.red(`probe failed: ${snap.err}`));

        for (const l of A.boxLines(snap.gw.up ? 'Status' : 'Stopped', body)) out.push(l);
        return out;
    }

      const gatesNow = G.read();
      const cfg = LC.read();
      const ready = LC.validate(cfg, gatesNow.gates);
      const items = [
          { label: 'Webchats', hint: `${gatesNow.gates.length} configured · ${gatesNow.gates.filter((g) => g.connected).length} connected`, value: 'webchats' },
          { label: 'Agentic harness', hint: cfg.harnesses.length ? cfg.harnesses.join(', ') : 'choose which agent to run', value: 'harnesses' },
          { label: 'Permission mode', hint: cfg.mode + (cfg.mode === 'yolo' ? ' — no gate at all' : ''), value: 'mode' },
          { label: ready.ok ? 'Launch' : 'Launch (not ready yet)', hint: ready.ok ? LC.summarize(cfg) : ready.problems[0], value: 'plan' },
          { label: 'Tools', hint: 'switch individual tools on or off', value: 'tools' },
          { label: 'Config', hint: 'every setting, grouped, with the source it resolves from', value: 'settings' },
          { label: 'Agent access (MCP)', hint: 'let any agent drive this harness', value: 'agentaccess' },
          { label: 'Logs', hint: 'gateway output, with a one-click bug report', value: 'logs' },
          { label: 'Doctor', hint: 'check everything and report', value: 'doctor' },
          { label: 'Quit', value: 'quit' },
      ];

    // Auto-refresh only while the menu is waiting. A tick re-renders the panel and
    // leaves the cursor exactly where the user left it.
    const tickMs = Number.isFinite(refreshS) && refreshS > 0 ? Math.min(60, refreshS) * 1000 : 0;
    let timer = null;
    if (tickMs > 0) {
        timer = setInterval(() => { refresh().catch(() => {}); }, tickMs);
        if (timer.unref) timer.unref();
    }

    try {
        return await A.menu(items, {
            title: 'What do you want to do?',
            tickMs,
            onTick: frame,
            footer: [`${A.dim('updated')} ${fmtClock(snap.at)}`
                + (tickMs ? A.gray(`  ·  auto-refresh ${tickMs / 1000}s (Settings → Dashboard)`)
                          : A.gray('  ·  auto-refresh off'))],
        });
    } finally {
        if (timer) clearInterval(timer);
    }
}


// ── Webchat & browser ──────────────────────────────────────────────────────
async function screenSite() {
    for (;;) {
        const st = state();
        const rows = rowsOf(st);
        const modeRow = rows.find((r) => r.setting.path === 'webchat.mode');
        const cdpPort = Number(process.env.CDP_PORT || 9225);
        const cdp = await D.cdpAlive(cdpPort);

          A.clear();
          header(['Webchat & browser']);
          const conn = D.readConnection();
          const body = [
              `${A.dim('selected')}  ${A.bold(modeRow.value || '(unset)')}`,
              `${A.dim('browser')}   ${cdp.up ? A.green(`running on CDP :${cdpPort}`) : A.gray('not running')}`,
              `${A.dim('profile')}   ${shortHome(D.profileDir())}`,
              `${A.dim('connected')} ${conn
                  ? A.green(`${conn.mode}${conn.agent ? ` → ${conn.agent}` : ''}`)
                  : A.gray('not yet — launch, log in, then Connect')}`,
          ];
        if (modeRow.shadowedBy) {
            body.push('');
            body.push(A.yellow(`⚠ ${modeRow.shadowedBy} in ${shortHome(modeRow.shadowedWhere)} overrides the file`));
        }
        for (const l of A.boxLines('Connection', body)) A.line(l);
        A.newline();

        const choice = await A.menu([
            { label: 'Choose webchat', hint: `${S.listModes(st.raw).length} configured`, value: 'pick' },
            { label: '1. Launch browser & log in', hint: 'opens a headed window on your desktop', value: 'launch' },
            { label: '2. Connect', hint: 'verify the tab is signed in, then save the choice', value: 'check' },
            { label: 'Attach to a browser I already have open', hint: 'connect to an existing CDP port', value: 'attach' },
            { label: 'Back', value: 'back' },
        ], { title: 'Connection' });

        if (choice === A.BACK || choice === 'back') return;
        if (choice === 'pick') await screenPickMode();
        else if (choice === 'launch') await screenLaunch();
        else if (choice === 'attach') await screenAttach();
        else if (choice === 'check') await screenCheck();
    }
}

async function screenPickMode() {
    const st = state();
    const modes = S.listModes(st.raw);
    const pick = await A.menu(
        modes.map((m) => ({ label: m.id, hint: m.url || '', value: m.id }))
            .concat([{ label: 'Back', value: 'back' }]),
        { title: 'Which webchat?', footer: ['Saved to the config file. If an env var shadows it, the CLI says so.'] },
    );
    if (pick === A.BACK || pick === 'back') return;

    const { raw, file } = S.loadRaw();
    S.setPath(raw, 'webchat.mode', pick);
    S.saveRaw(raw, file);

    // The mode is very often pinned in .env. Leaving that line in place means the
    // edit does nothing, so offer to clear it rather than reporting a false save.
    const dotenv = S.loadDotenv();
    if (dotenv.vars.WEBCHAT_MODE) {
        const clear = await A.confirm(
            `WEBCHAT_MODE is also set in ${path.basename(dotenv.file)}, and an environment\nvariable overrides the config file.\n\nRemove that line so the file takes effect?`,
            { footer: 'Answering No leaves the existing webchat active.' },
        );
        if (clear === true) {
            const text = fs.readFileSync(dotenv.file, 'utf-8');
            fs.writeFileSync(dotenv.file, S.removeEnvVar(text, 'WEBCHAT_MODE'), { mode: 0o600 });
            await A.message('Cleared', [
                `Removed WEBCHAT_MODE from ${shortHome(dotenv.file)}.`,
                `The config file value "${pick}" now applies.`,
            ]);
            return;
        }
        await A.message('Saved to the file', [
            `${A.yellow('Not in effect yet.')} WEBCHAT_MODE still overrides it.`,
            '',
            `To switch, remove that line from ${shortHome(dotenv.file)}.`,
        ]);
        return;
    }
    await A.message('Saved', [`webchat mode = ${A.cyan(pick)}`]);
}

  async function screenLaunch() {
      const st = state();
      const rows = rowsOf(st);
      const mode = rows.find((r) => r.setting.path === 'webchat.mode').value;
      const url = (S.listModes(st.raw).find((m) => m.id === mode) || {}).url || '';

      if (D.browserRunning()) {
          await A.message('Browser already running', [
              'A browser launched by this CLI is already up.',
              '',
              `Use ${A.bold('Connect')} to check the tab and continue.`,
          ]);
          return;
      }
      const go = await A.confirm(
          `Launch a browser window and open ${url || 'the webchat'}?`,
          {
              footer: [
                  'It opens HEADED on your real desktop, because you sign in yourself.',
                  'The profile lives under .webchat/ so the login survives restarts.',
              ],
          },
      );
      if (go !== true) return;

      const port = Number(process.env.CDP_PORT || 9225);
      // headed on purpose: this is the one launch a human must SEE.
      const res = D.launchBrowser({ port, url });
      if (!res.started) {
          await A.message('Could not launch', [A.red(res.error || 'unknown error')]);
          return;
      }
      await A.message('Browser launched', [
          A.dim(res.executable),
          '',
          A.bold('Sign in to the webchat in that window.'),
          'When the chat page is loaded and signed in, come back here and choose',
          `${A.bold(A.cyan('Connect'))} — it verifies the tab and saves the choice.`,
          '',
          A.dim(`display ${res.display}   profile ${shortHome(res.profile)}`),
          A.dim(`cdp     http://127.0.0.1:${port}`),
      ]);
  }


async function screenAttach() {
    const port = await A.prompt('CDP port of the browser you already have open', {
        default: String(process.env.CDP_PORT || 9225),
        hint: 'Chrome only exposes this when launched with --remote-debugging-port and a non-default profile.',
        validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536) ? null : 'a port is 1-65535',
    });
    if (port === A.BACK) return;

    const alive = await D.cdpAlive(Number(port));
    if (!alive.up) {
        await A.message('Cannot reach that browser', [
            `Nothing answered on 127.0.0.1:${port} with a DevTools endpoint.`,
            '',
            A.dim('Launch Chrome with:'),
            A.dim('  --remote-debugging-port=<port> --user-data-dir=<non-default dir>'),
        ]);
        return;
    }

    const st = state();
    const rows = rowsOf(st);
    const mode = rows.find((r) => r.setting.path === 'webchat.mode').value;
    const url = (S.listModes(st.raw).find((m) => m.id === mode) || {}).url || '';
    const host = url ? new URL(url).hostname.replace(/^www\./, '') : '';

    const targets = await D.cdpTargets(Number(port));
    const match = targets.pages.find((p) => host && (p.url || '').includes(host));
    const body = [`Found ${targets.pages.length} tab(s) on :${port}.`, ''];
    for (const p of targets.pages.slice(0, 8)) {
        const hit = p === match ? A.green('  ← match') : '';
        body.push(A.truncate(`  ${p.title || '(untitled)'}`, A.termWidth() - 30));
        body.push(A.gray(A.truncate(`    ${p.url}`, A.termWidth() - 8)) + hit);
    }
    if (!match) body.push('', A.yellow('No tab matches the selected webchat. Open it there, then retry.'));
    await A.message('Tabs', body);

    if (!match) return;
    const { raw, file } = S.loadRaw();
    S.setPath(raw, 'webchat.cdpWsUrl', match.webSocketDebuggerUrl);
    S.saveRaw(raw, file);
    await A.message('Pinned', [
        'The harness will now attach to that exact tab instead of launching its own browser.',
        '',
        A.dim(`cdpWsUrl = ${match.webSocketDebuggerUrl}`),
    ]);
}

// Probe the tab itself: the composer is the one element every supported webchat
// has exactly when it is loaded AND signed in.
async function probeComposer(port, modeCfg, host) {
    const selectorList = (modeCfg.selectors && modeCfg.selectors.input) || 'div[contenteditable="true"], textarea';
    try {
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.connect({ browserWSEndpoint: `http://127.0.0.1:${port}` });
        try {
            const pages = await browser.pages();
            const target = pages.find((p) => host && p.url().includes(host)) || pages[0];
            if (!target) return { ok: false, reason: 'the browser has no tabs' };
            return await target.evaluate((sels) => {
                for (const sel of String(sels).split(',').map((s) => s.trim()).filter(Boolean)) {
                    const el = document.querySelector(sel);
                    if (el && el.getClientRects().length > 0) {
                        return { ok: true, matched: sel, url: location.href, title: document.title };
                    }
                }
                const text = (document.body ? document.body.innerText : '').slice(0, 3000);
                const out = /sign in|log in|登录|sign-in/i.test(text);
                return {
                    ok: false,
                    reason: out ? 'that page looks logged out' : 'the composer was not found',
                    url: location.href,
                    title: document.title,
                };
            }, selectorList);
        } finally {
            await browser.disconnect();
        }
    } catch (e) {
        return { ok: false, reason: `could not inspect the tab: ${e.message}` };
    }
}

async function screenCheck() {
    const port = Number(process.env.CDP_PORT || 9225);
    const alive = await D.cdpAlive(port);
    if (!alive.up) {
        await A.message('No browser on the debugging port', [
            `Nothing answered on 127.0.0.1:${port}.`,
            '',
            'Launch the browser from here first, or use Attach if you already have one open.',
        ]);
        return;
    }

    const st = state();
    const rows = rowsOf(st);
    const mode = rows.find((r) => r.setting.path === 'webchat.mode').value;
    const modeCfg = S.listModes(st.raw).find((m) => m.id === mode) || {};
    const host = modeCfg.url ? new URL(modeCfg.url).hostname.replace(/^www\./, '') : '';

    A.clear();
    header(['Checking connection']);
    A.line(`  ${A.dim('webchat')}      ${mode}`);
    A.line(`  ${A.dim('looking for')}  ${host || '(any tab)'}`);
    A.newline();
    A.line(`  ${A.gray('inspecting the tab…')}`);

    const probe = await probeComposer(port, modeCfg, host);

    A.clear();
    header(['Connection check']);
    const body = [
        `${A.dim('tab')}       ${A.truncate(probe.title || '(untitled)', A.termWidth() - 16)}`,
        `${A.dim('url')}       ${A.truncate(probe.url || '', A.termWidth() - 16)}`,
        `${A.dim('composer')}  ${probe.ok ? A.green('found — loaded and signed in') : A.red(probe.reason || 'not found')}`,
    ];
    for (const l of A.boxLines(probe.ok ? 'Ready' : 'Not ready', body)) A.line(l);
    A.newline();

    if (!probe.ok) {
        await A.message('Not ready', [
            'The harness needs the chat page open and signed in.',
            '',
            probe.reason && probe.reason.includes('logged out')
                ? 'That page looks logged out — sign in, then check again.'
                : 'The composer was not found. If the site changed its DOM, edit the input selector under All settings.',
        ]);
        return;
    }

    const ok = await A.menu([
        { label: 'Yes — this is the tab', hint: 'mark it connected', value: true },
        { label: 'No', value: false },
    ], {
        title: `Connected to ${mode}?`,
        footer: ['The CLI checked; you confirm. A tab that looks right can still be the wrong thread.'],
    });
    if (ok !== true) return;

      const targets = await D.cdpTargets(port);
      const page = targets.pages.find((p) => host && (p.url || '').includes(host)) || targets.pages[0];
      const { raw, file } = S.loadRaw();
      if (page && page.webSocketDebuggerUrl) S.setPath(raw, 'webchat.cdpWsUrl', page.webSocketDebuggerUrl);
      S.saveRaw(raw, file);

      // Record what was connected, for `webchat connect` in the other terminal.
      // Keeping the previously chosen agent means the second command never has to
      // ask again — it acts on the decision already made here.
      const prev = D.readConnection() || {};
      D.writeConnection({
          mode,
          cdpPort: port,
          cdpWsUrl: (page && page.webSocketDebuggerUrl) || null,
          targetUrl: (page && page.url) || null,
          agent: prev.agent || null,
          connectedAt: new Date().toISOString(),
      });

      await A.message('Connected', [
          A.green('This webchat is marked connected.'),
          '',
          A.bold('Next — in a NEW terminal:'),
          `    ${A.bold(A.cyan('webchat connect'))}`,
          '',
          A.dim('It starts the harness against this browser and opens your agent.'),
          A.dim('Leave the browser window alone — the harness drives it from now on.'),
      ]);
}

// ── All settings ───────────────────────────────────────────────────────────
async function screenSettings() {
    for (;;) {
        const st = state();
        const rows = rowsOf(st);
        A.clear();
        header(['All settings']);
        const body = [];
        for (const g of S.SCHEMA) {
            const inGroup = rows.filter((r) => r.group === g.id);
            const shadow = inGroup.filter((r) => r.shadowedBy).length;
            body.push(`${A.bold(g.title)}  ${A.dim(`${inGroup.length} setting(s)`)}${shadow ? '  ' + A.yellow(`${shadow} env-shadowed`) : ''}`);
            body.push(A.gray(`  ${g.blurb}`));
            body.push('');
        }
        for (const l of A.boxLines('', body)) A.line(l);
        A.newline();

        const pick = await A.menu(
            S.SCHEMA.map((g) => ({
                label: g.title,
                hint: `${g.settings.filter((s) => !s.advanced).length} basic`,
                value: g.id,
            })).concat([{ label: 'Back', value: 'back' }]),
            { title: 'Which group?' },
        );
        if (pick === A.BACK || pick === 'back') return;
        await screenSettingsGroup(pick);
    }
}

async function screenSettingsGroup(groupId) {
    for (;;) {
        const st = state();
        const group = S.SCHEMA.find((g) => g.id === groupId);
        const rows = rowsOf(st).filter((r) => r.group === groupId);
        const visible = rows.filter((r) => SHOW_ADVANCED || !r.setting.advanced);

        A.clear();
        header([group.title]);
        const body = visible.map((r) => {
            const risk = r.setting.risk && r.value ? A.red('  ⚠') : '';
            const shadow = r.shadowedBy ? A.yellow(`   [env: ${r.shadowedBy}]`) : '';
            return `${A.bold(r.setting.label)}${risk}\n  ${A.cyan(S.display(r.setting, r.value))}${shadow}`;
        });
        for (const l of A.boxLines('', body)) A.line(l);
        A.newline();

        const items = visible.map((r) => ({
            label: r.setting.label,
            hint: S.display(r.setting, r.value).slice(0, 44) + (r.shadowedBy ? '  [env]' : ''),
            value: r.setting.path,
        }));
        const hiddenCount = rows.length - visible.length;
        items.push({
            label: SHOW_ADVANCED ? 'Hide advanced' : `Show advanced${hiddenCount ? ` (${hiddenCount} hidden)` : ''}`,
            value: '__toggle_adv',
        });
        items.push({ label: 'Back', value: 'back' });

        const pick = await A.menu(items, { title: group.title });
        if (pick === A.BACK || pick === 'back') return;
        if (pick === '__toggle_adv') { SHOW_ADVANCED = !SHOW_ADVANCED; continue; }
        await editSetting(pick);
    }
}

async function editSetting(settingPath) {
    const setting = S.BY_PATH.get(settingPath);
    if (!setting) return;
    const st = state();
    const row = rowsOf(st).find((r) => r.setting.path === settingPath);

    A.clear();
    header([setting.groupTitle, setting.label]);
    const body = [
        `${A.dim('effective')}  ${A.cyan(S.display(setting, row.value))}`,
        `${A.dim('source')}     ${row.source === 'env' ? A.yellow(`environment (${shortHome(row.shadowedWhere)})`) : row.source}`,
        row.shadowedFileValue !== undefined
            ? `${A.dim('file says')}  ${S.display(setting, row.shadowedFileValue)} ${A.yellow('— overridden')}`
            : `${A.dim('env var')}    ${setting.env || '(none)'}`,
    ];
    if (setting.help) {
        body.push('');
        for (const l of A.wrap(setting.help, A.termWidth() - 8)) body.push(l);
    }
    if (setting.risk && row.value) body.push('', A.red('⚠ Loosens a safety gate — read the description above.'));
    for (const l of A.boxLines('', body)) A.line(l);
    A.newline();

    const items = [{ label: 'Change value', value: 'set' }];
    if (row.shadowedBy) {
        items.push({
            label: `Remove ${row.shadowedBy} from ${path.basename(st.dotenvFile)}`,
            hint: 'let the config file decide again',
            value: 'unshadow',
        });
    }
    if (row.source === 'file') items.push({ label: 'Reset', hint: 'remove it from the config file', value: 'reset' });
    items.push({ label: 'Back', value: 'back' });

    const action = await A.menu(items, { title: setting.label });
    if (action === A.BACK || action === 'back') return;

    if (action === 'unshadow') {
        const text = fs.readFileSync(st.dotenvFile, 'utf-8');
        fs.writeFileSync(st.dotenvFile, S.removeEnvVar(text, setting.env), { mode: 0o600 });
        await A.message('Removed', [
            `${setting.env} removed from ${shortHome(st.dotenvFile)}.`,
            row.shadowedFileValue !== undefined
                ? `The config file value now applies: ${S.display(setting, row.shadowedFileValue)}`
                : 'It now falls back to the built-in default.',
        ]);
        return;
    }

    if (action === 'reset') {
        const { raw, file } = S.loadRaw();
        S.setPath(raw, setting.path, undefined);
        S.saveRaw(raw, file);
        await A.message('Reset', [`${setting.path} removed from ${shortHome(file)}`]);
        return;
    }

    let next;
    if (setting.type === 'bool') {
        next = await A.menu([{ label: 'On', value: true }, { label: 'Off', value: false }], { title: setting.label });
        if (next === A.BACK) return;
    } else if (setting.type === 'mode') {
        const modes = S.listModes(st.raw).map((m) => ({ label: m.id, hint: m.url, value: m.id }));
        next = await A.menu(modes.concat([{ label: 'Back', value: 'back' }]), { title: 'Webchat' });
        if (next === A.BACK || next === 'back') return;
    } else {
        const current = Array.isArray(row.value) ? row.value.join(', ') : (row.value === undefined ? '' : String(row.value));
        next = await A.prompt(setting.label, {
            default: current,
            mask: setting.type === 'secret',
            hint: setting.help,
            validate: setting.validate,
        });
        if (next === A.BACK) return;
        if (setting.type === 'number') next = Number(next);
        else if (setting.type === 'list') next = String(next).split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (setting.envOnly) {
        const text = fs.readFileSync(st.dotenvFile, 'utf-8');
        fs.writeFileSync(st.dotenvFile, S.setEnvVar(text, setting.env, String(next)), { mode: 0o600 });
        await A.message('Saved', [`${setting.env} written to ${shortHome(st.dotenvFile)}`]);
        return;
    }

    // File-backed settings (memory.contents) write the actual file, not config JSON.
    if (setting.fileBacked) {
        const mem = require('../memory');
        mem.writeMemory(String(next ?? ''));
        await A.message('Saved', [
            `${setting.label} written to ${shortHome(mem.memoryFile())} (${mem.readMemory().length} chars).`,
        ]);
        return;
    }

    const { raw, file } = S.loadRaw();
    S.setPath(raw, setting.path, next);
    S.saveRaw(raw, file);

    // Warn rather than pretend. This is the whole reason the source is tracked.
    if (row.shadowedBy) {
        await A.message('Saved — but not in effect', [
            A.yellow(`${setting.env} is set in ${shortHome(row.shadowedWhere)},`),
            A.yellow('and an environment variable overrides the config file.'),
            'The harness will keep using the old value.',
            '',
            `Remove ${A.bold(setting.env)} to make this take effect (the option is on the previous screen).`,
        ]);
    } else {
        await A.message('Saved', [
            `${setting.label} = ${A.cyan(S.display(setting, next))}`,
            A.dim(`${setting.path}  →  ${shortHome(file)}`),
            '',
            A.dim('A running gateway picks this up on restart.'),
        ]);
    }
}

// ── Gates ──────────────────────────────────────────────────────────────────
async function screenGates() {
    for (;;) {
        const st = state();
        const rows = rowsOf(st);
        const g = (p) => rows.find((r) => r.setting.path === p);

        A.clear();
        header(['Gates & sandbox']);
        const body = [
            `${A.dim('run_bash')}            ${g('features.bashAllowed').value ? A.red('ENABLED') : A.green('disabled')}`,
            `${A.dim('sandbox allow bash')}  ${g('features.sandboxAllowBash').value ? A.red('ENABLED') : A.green('disabled')}`,
            `${A.dim('sandbox')}             ${g('features.sandbox').value ? A.green('on') : A.red('OFF')}`,
            `${A.dim('roots')}               ${(g('network.sandboxRoots').value || []).join(', ') || A.yellow('(none — nothing is reachable)')}`,
            `${A.dim('api token')}           ${g('__env__.API_TOKEN').value ? A.green('set') : A.gray('not set')}`,
            `${A.dim('throttle cooldown')}   ${g('features.rateLimitCooldownSeconds').value}s`,
            '',
            A.gray('A guardrail, not a kernel jail. Bash needs BOTH flags, and every'),
            A.gray('path in a command must resolve inside a root.'),
        ];
        for (const l of A.boxLines('Current posture', body)) A.line(l);
        A.newline();

        const choice = await A.menu([
            { label: 'Allow run_bash', hint: g('features.bashAllowed').value ? 'on' : 'off', value: 'features.bashAllowed' },
            { label: 'Sandbox: allow bash', hint: g('features.sandboxAllowBash').value ? 'on' : 'off', value: 'features.sandboxAllowBash' },
            { label: 'Enable sandbox', hint: g('features.sandbox').value ? 'on' : 'off', value: 'features.sandbox' },
            { label: 'Sandbox roots', hint: `${(g('network.sandboxRoots').value || []).length} root(s)`, value: 'network.sandboxRoots' },
            { label: 'Command timeout', hint: `${g('limits.execTimeoutMs').value} ms`, value: 'limits.execTimeoutMs' },
            { label: 'API token', hint: g('__env__.API_TOKEN').value ? 'set' : 'not set', value: '__env__.API_TOKEN' },
            { label: 'Back', value: 'back' },
        ], { title: 'Gates' });
        if (choice === A.BACK || choice === 'back') return;

        if (choice === 'features.bashAllowed' && !g('features.bashAllowed').value) {
            const ok = await A.confirm(
                'Enable run_bash?\n\nThe model will be able to execute shell commands. They stay fenced by the sandbox roots, but that fence is a token scan, not a kernel jail.',
                { footer: 'Only enable this when you trust the conversation content end to end.' },
            );
            if (ok !== true) continue;
        }
        await editSetting(choice);
    }
}

// ── Start ──────────────────────────────────────────────────────────────────
async function screenStart() {
    const st = state();
    const rows = rowsOf(st);
    const host = rows.find((r) => r.setting.path === 'server.host').value || '127.0.0.1';
    const port = rows.find((r) => r.setting.path === 'server.port').value || 8080;
    const allowPlain = rows.find((r) => r.setting.path === 'features.allowPlainText').value;

    A.clear();
    header(['Start the harness']);

    // The gateway first: it is what an IDE talks to, and it attaches to the
    // browser lazily on the first request.
    let gw = await D.probeGateway(host, port);
    if (gw.up) {
        A.line(`  ${A.green('✓')} gateway already up on ${host}:${port}`);
    } else {
        A.line(`  ${A.dim('gateway')}  starting…`);
        const res = D.startGateway();
        if (!res.started && res.reason !== 'already running') {
            A.newline();
            await A.message('Could not start the gateway', [A.red(res.reason || 'unknown error')]);
            return;
        }
        for (let i = 0; i < 24; i++) {
            await new Promise((r) => setTimeout(r, 500));
            gw = await D.probeGateway(host, port);
            if (gw.up) break;
            A.write('.');
        }
        A.newline();
        if (!gw.up) {
            await A.message('Gateway did not come up', [
                `Nothing answered on ${host}:${port} after 12s.`,
                '',
                'Check the log (Logs on the main menu). Common causes:',
                '  · the port is already used by something else',
                '  · a config value the harness rejects at boot',
            ]);
            return;
        }
    }

    const cdpPort = Number(process.env.CDP_PORT || 9225);
    const cdp = await D.cdpAlive(cdpPort);

    A.newline();
    const body = [
        `${A.dim('gateway')}   ${A.green(`up on http://${host}:${port}`)}`,
        `${A.dim('browser')}   ${cdp.up ? A.green(`running on CDP :${cdpPort}`) : A.yellow('not running — the gateway will launch one on first use')}`,
        `${A.dim('webchat')}   ${rows.find((r) => r.setting.path === 'webchat.mode').value}`,
        `${A.dim('model id')}  ${rows.find((r) => r.setting.path === 'server.modelName').value}`,
        '',
        A.gray(allowPlain
            ? 'Plain-text replies are accepted.'
            : 'Tool mode: every reply must be exactly one fenced tool call.'),
    ];
    for (const l of A.boxLines('Running', body)) A.line(l);
    A.newline();

    const pick = await A.menu([
        { label: 'Start my IDE against it', hint: 'opens the agent wired to this gateway', value: 'ide' },
        { label: 'Show the connection details', hint: 'base URL, model id, env vars', value: 'details' },
        { label: 'Back', value: 'back' },
    ], { title: 'Gateway is up' });
    if (pick === A.BACK || pick === 'back') return;
    if (pick === 'details') {
        await A.message('Connection details', [
            `base URL   ${A.cyan(`http://${host}:${port}/v1`)}`,
            `model id   ${A.cyan(rows.find((r) => r.setting.path === 'server.modelName').value)}`,
            '',
            A.dim('Any OpenAI-compatible client works: point it at that base URL'),
            A.dim('and pick any model name.'),
            '',
            'Or use the launcher, which exports the right variables for you:',
            A.dim('  ./launch-agent.sh opencode|claude|codex|aider|hermes|crush|any'),
        ]);
        return;
    }
    await screenLaunchIde(host, port, rows);
}

async function screenLaunchIde(host, port, rows) {
    const launcher = path.join(D.REPO, 'launch-agent.sh');
    const model = rows.find((r) => r.setting.path === 'server.modelName').value;

    const agents = ['opencode', 'claude', 'codex', 'aider', 'hermes', 'crush'];
    const pick = await A.menu(
        agents.map((a) => ({ label: a, value: a }))
            .concat([{ label: 'Back', value: 'back' }]),
        {
            title: 'Which agent?',
            footer: [
                'launch-agent.sh exports the base URL and model, then execs it.',
                `base URL http://${host}:${port}/v1   model ${model}`,
            ],
        },
    );
    if (pick === A.BACK || pick === 'back') return;

    if (!fs.existsSync(launcher)) {
        await A.message('Launcher missing', [
            `Expected ${launcher}`,
            'Use the connection details instead and point your client at the base URL.',
        ]);
        return;
    }

    A.clear();
    A.line(`  ${A.dim('$')} ./launch-agent.sh ${pick}`);
    A.newline();
    // Hand the terminal to the agent. This is the one place the CLI execs rather
    // than spawns: the user asked to run that program, and it owns the TTY.
    D.restoreForExec();
    const { spawnSync } = require('child_process');
    const res = spawnSync(launcher, [pick], { cwd: D.REPO, stdio: 'inherit' });
    if (res.error) {
        await A.message('Could not launch', [A.red(res.error.message)]);
    } else if (res.status !== 0) {
        await A.message('Launcher exited', [`Exit code ${res.status}.`]);
    }
}

// ── Logs ───────────────────────────────────────────────────────────────────
async function screenLogs() {
    for (;;) {
        const which = await A.menu([
            { label: 'Gateway output', hint: shortHome(D.logFile('gateway')), value: 'gateway' },
            { label: 'Gateway errors', hint: shortHome(D.logFile('gateway.err')), value: 'gateway.err' },
            { label: 'Report a problem', hint: 'copy the details, or open a pre-filled issue', value: 'report' },
            { label: 'Back', value: 'back' },
        ], { title: 'Logs' });
        if (which === A.BACK || which === 'back') return;
        if (which === 'report') { await screenReport(); continue; }

        const lines = D.tailLines(D.logFile(which), A.bodyRows(6));
        A.clear();
        header(['Logs', which]);
        if (!lines.length) {
            A.line(`  ${A.gray(`(no output yet — ${shortHome(D.logFile(which))})`)}`);
        }
        for (const l of lines) {
            const colour = /error|ERR|fail|❌|⛔/i.test(l) ? A.red
                : /warn|⚠/i.test(l) ? A.yellow
                    : /✅|✓|ok\b/i.test(l) ? A.green : (s) => s;
            A.line(A.truncate(colour(l), A.termWidth() - 2));
        }
        A.newline();
        const key = await A.menu([
            { label: 'Refresh', value: 'r' },
            { label: 'Report a problem', hint: 'with this log attached', value: 'report' },
            { label: 'Back', value: 'back' },
        ], { title: '' });
        if (key === 'report') { await screenReport({ source: which }); continue; }
        if (key !== 'r') return;
    }
}

// ── Reporting a problem ────────────────────────────────────────────────────
//
// The owner asked for this to be easy: an error, a copyable report, and a link to
// open an issue under their repo. So the screen does three things and none of them
// require the user to assemble anything by hand:
//
//   1. it collects what a maintainer actually needs (versions, OS, which log, the
//      last errors) into one block;
//   2. it puts that block on the CLIPBOARD, because "copy this" that requires manual
//      selection is not copyable;
//   3. it opens a pre-filled GitHub issue, so the report arrives structured.
//
// It never includes a secret. The env is filtered to names, never values — a bug
// report is the last place an API key should end up.
function collectDiagnostics(extra = {}) {
    const st = state();
    const rows = rowsOf(st);
    const gates = G.read();
    const cfg = LC.read();
    const sh = (c, a) => {
        try {
            return require('child_process').execFileSync(c, a, { encoding: 'utf-8', timeout: 3000 }).trim();
        } catch { return null; }
    };
    // Only the NAMES of the environment variables the harness reads. Values are
    // deliberately not included: several of them are credentials.
    const harnessEnvNames = Object.keys(process.env)
        .filter((k) => /^(WEBCHAT|HARNESS|CDP|PORT|HOST|MODEL|BASH|SEND_GAP|MIN_SEND)/.test(k))
        .sort();

    const logs = {};
    for (const which of ['gateway', 'gateway.err']) {
        const lines = D.tailLines(D.logFile(which), 60);
        logs[which] = lines.filter((l) => /error|fail|❌|⛔|⚠|Traceback/i.test(l)).slice(-12);
    }

    return {
        generatedAt: new Date().toISOString(),
        harness: {
            commit: sh('git', ['-C', path.join(__dirname, '..'), 'rev-parse', '--short', 'HEAD']),
            branch: sh('git', ['-C', path.join(__dirname, '..'), 'rev-parse', '--abbrev-ref', 'HEAD']),
        },
        runtime: {
            node: process.version,
            platform: `${process.platform} ${process.arch}`,
            release: (() => { try { return require('os').release(); } catch { return null; } })(),
        },
        webchats: gates.gates.map((g) => ({ id: g.id, site: g.site, connected: g.connected, cdpPort: g.cdpPort, gatewayPort: g.gatewayPort })),
        launchConfig: cfg,
        // Which settings are non-default, and where each value comes from — enough to
        // reproduce without shipping the user's whole config.
        settingsNonDefault: rows
            .filter((r) => r.source !== 'default' && !/_comment|secret|key|token|password/i.test(r.setting.path))
            .map((r) => ({ path: r.setting.path, source: r.source, shadowedBy: r.shadowedBy || null })),
        envNamesSet: harnessEnvNames,
        errors: logs,
        source: extra.source || null,
        note: extra.note || null,
    };
}

function reportText(diag) {
    return [
        `webchat harness — problem report`,
        `generated: ${diag.generatedAt}`,
        ``,
        `harness: ${diag.harness.branch || '?'} @ ${diag.harness.commit || '?'}`,
        `runtime: node ${diag.runtime.node}, ${diag.runtime.platform}`,
        ``,
        `webchats: ${diag.webchats.length ? diag.webchats.map((g) => `${g.id}(${g.site}${g.connected ? ',connected' : ''})`).join(' ') : 'none'}`,
        `launch:   ${diag.launchConfig.gates.join('+') || 'none'} -> ${diag.launchConfig.harnesses.join('+') || 'none'} [${diag.launchConfig.mode}]`,
        ``,
        `settings changed from default:`,
        ...(diag.settingsNonDefault.length
            ? diag.settingsNonDefault.map((s) => `  ${s.path}  (${s.source}${s.shadowedBy ? `, shadowed by ${s.shadowedBy}` : ''})`)
            : ['  (none)']),
        ``,
        `environment variables set: ${diag.envNamesSet.join(', ') || '(none)'}`,
        ``,
        ...(diag.errors.gateway.length ? ['recent gateway output:', ...diag.errors.gateway.map((l) => '  ' + l)] : []),
        ...(diag.errors['gateway.err'].length ? ['recent errors:', ...diag.errors['gateway.err'].map((l) => '  ' + l)] : []),
        ``,
        diag.note ? `what I was doing: ${diag.note}` : `what I was doing: (describe here)`,
        ``,
        `(no secrets are included — only setting names and sources)`,
    ].join('\n');
}

function issueUrl(diag) {
    const title = encodeURIComponent('[harness] ');
    const body = encodeURIComponent(
        '<!-- Describe what you expected and what happened. The block below is generated and contains no secrets. -->\n\n'
        + reportText(diag),
    );
    // The canonical repo for this harness. A user with their own fork can change it.
    const repo = process.env.WEBCHAT_ISSUE_REPO || 'ronisaguey-ux/webchat-to-api-harness';
    return `https://github.com/${repo}/issues/new?title=${title}&body=${body}`;
}

async function screenReport(extra = {}) {
    const diag = collectDiagnostics(extra);
    const txt = reportText(diag);

    A.clear();
    header(['Report a problem']);
    for (const l of A.boxLines('What will be sent', [
        'A short technical summary — versions, which webchats exist, which',
        'settings differ from their defaults, and the last errors.',
        '',
        A.green('No secrets: setting NAMES only, never their values.'),
        '',
        A.dim('Open the issue link and a browser tab opens with this pre-filled.'),
        A.dim('Describe what you were doing there before you submit.'),
    ])) A.line(l);
    A.newline();
    A.line(A.gray('  ─── the report ───'));
    for (const l of txt.split('\n').slice(0, A.bodyRows(22))) {
        A.line(A.truncate(A.gray('  ' + l), A.termWidth() - 2));
    }
    A.newline();

    const choice = await A.menu([
        { label: 'Copy to clipboard', hint: 'paste it anywhere', value: 'copy' },
        { label: 'Open a pre-filled GitHub issue', hint: 'in your browser', value: 'open' },
        { label: 'Save to a file', hint: shortHome('/tmp/webchat-report.txt'), value: 'save' },
        { label: 'Back', value: 'back' },
    ], { title: '' });

    if (choice === 'copy') {
        const res = D.copyToClipboard ? D.copyToClipboard(txt) : { ok: false, reason: 'no clipboard helper' };
        await A.message(res.ok ? 'Copied' : 'Could not copy', [
            res.ok ? 'The report is on your clipboard — paste it into the issue.' : A.red(res.reason || 'clipboard unavailable'),
            A.dim('Use "Save to a file" instead if the clipboard is not available.'),
        ]);
        return screenReport(extra);
    }
    if (choice === 'save') {
        const file = '/tmp/webchat-report.txt';
        try {
            fs.writeFileSync(file, txt, { mode: 0o600 });
            await A.message('Saved', [shortHome(file)]);
        } catch (e) {
            await A.message('Could not save', [A.red(e.message)]);
        }
        return screenReport(extra);
    }
    if (choice === 'open') {
        const url = issueUrl(diag);
        try {
            require('child_process').spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
            await A.message('Opened in your browser', [
                'A GitHub issue is pre-filled with the report above.',
                A.dim('Add what you were doing, then submit.'),
            ]);
        } catch (e) {
            A.clear();
            header(['Report a problem']);
            A.line('  Could not open a browser. Copy this link instead:');
            A.newline();
            A.line('  ' + A.cyan(url.slice(0, A.termWidth() - 4)));
            if (url.length > A.termWidth() - 4) A.line('  ' + A.cyan(url.slice(A.termWidth() - 4)));
            A.newline();
            await A.readKey();
        }
        return screenReport(extra);
    }
}

// ── Agent access (MCP) ─────────────────────────────────────────────────────
//
// The harness is reachable as an MCP server so ANY agent can drive it. This screen
// shows the exact line to paste into a client's config and writes the ones it can.
async function screenAgentAccess() {
    const serverPath = path.join(__dirname, '..', 'mcp-server.js');
    let toolCount = 0;
    try {
        toolCount = require('../mcp-server').TOOLS.length;
    } catch { /* report 0 rather than guessing */ }

    A.clear();
    header(['Agent access', 'MCP']);
    for (const l of A.boxLines('Let any agent drive this harness', [
        'The harness speaks MCP, so any agent that supports it can read and',
        'change the config, add and connect webchats, run the harness tools,',
        'and put whole tasks through a webchat as a subagent.',
        '',
        `${A.bold(String(toolCount))} tools are exposed.`,
        '',
        A.dim('Add this to your MCP client config:'),
        '',
        `  ${A.cyan('"webchat"')}: {`,
        `    ${A.cyan('"type"')}: "local",`,
        `    ${A.cyan('"command"')}: ["node", ${A.cyan(`"${serverPath}"`)}]`,
        `  }`,
    ])) A.line(l);
    A.newline();

    const choice = await A.menu([
        { label: 'Copy the config block', hint: 'paste it into your agent', value: 'copy' },
        { label: 'List the tools', hint: `${toolCount} available`, value: 'list' },
        { label: 'Back', value: 'back' },
    ], { title: '' });

    if (choice === 'copy') {
        const block = JSON.stringify({ webchat: { type: 'local', command: ['node', serverPath] } }, null, 2);
        const res = D.copyToClipboard ? D.copyToClipboard(block) : { ok: false, reason: 'no clipboard helper' };
        await A.message(res.ok ? 'Copied' : 'Could not copy', [
            res.ok ? 'Paste it into your MCP client config.' : A.red(res.reason || 'clipboard unavailable'),
        ]);
        return screenAgentAccess();
    }
    if (choice === 'list') {
        A.clear();
        header(['Agent access', 'tools']);
        let tools = [];
        try { tools = require('../mcp-server').TOOLS; } catch { /* shown empty */ }
        for (const t of tools) {
            A.line(`  ${A.bold(t.name)}`);
            A.line(A.gray('    ' + A.truncate(String(t.description).split('.')[0] + '.', A.termWidth() - 8)));
        }
        A.newline();
        A.line(A.gray('  any key to go back'));
        await A.readKey();
        return screenAgentAccess();
    }
}

// ── Doctor ─────────────────────────────────────────────────────────────────
async function screenDoctor() {
    const st = state();
    const rows = rowsOf(st);
    const get = (p) => rows.find((r) => r.setting.path === p);
    const checks = [];

    checks.push({ name: 'config file', ok: !st.missing && !st.error, detail: st.missing ? 'not found' : (st.error ? st.error.message : shortHome(st.file)) });
    checks.push({ name: 'harness/.env', ok: fs.existsSync(st.dotenvFile), detail: shortHome(st.dotenvFile) });
    checks.push({ name: 'node', ok: true, detail: process.version });
    checks.push({ name: 'chrome', ok: Boolean(D.chromePath()), detail: D.chromePath() || 'not found — set CHROME_PATH' });
    checks.push({ name: 'puppeteer', ok: (() => { try { require.resolve('puppeteer'); return true; } catch { return false; } })(), detail: 'required to inspect and drive the tab' });

    const launcher = path.join(D.REPO, 'launch-agent.sh');
    checks.push({ name: 'launch-agent.sh', ok: fs.existsSync(launcher), detail: shortHome(launcher) });

    const host = get('server.host').value || '127.0.0.1';
    const port = get('server.port').value || 8080;
    const gw = await D.probeGateway(host, port);
    checks.push({
        name: 'gateway',
        ok: gw.up,
        detail: gw.up ? `up on ${host}:${port} (browser ${gw.attached ? 'attached' : 'not attached yet'})` : 'not running',
    });

    const cdpPort = Number(process.env.CDP_PORT || 9225);
    const cdp = await D.cdpAlive(cdpPort);
    checks.push({ name: 'browser', ok: cdp.up, detail: cdp.up ? `CDP :${cdpPort}` : `nothing on :${cdpPort}` });

    const roots = get('network.sandboxRoots').value || [];
    const missingRoots = roots.filter((r) => !fs.existsSync(String(r).replace(/^~(?=\/)/, process.env.HOME || '~')));
    checks.push({
        name: 'sandbox roots',
        ok: roots.length > 0 && missingRoots.length === 0,
        detail: roots.length === 0 ? 'none set — the model cannot reach anything'
            : missingRoots.length ? `missing: ${missingRoots.join(', ')}`
                : `${roots.length} exist`,
    });

    const shadowed = rows.filter((r) => r.shadowedBy);

    // The bind guard in server.js refuses a non-loopback bind with no token, so
    // say it here too: the user is about to be told the gateway will not start.
    const bindHost = String(host);
    const nonLoopback = !(bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1');
    const tokenSet = Boolean(process.env.API_TOKEN || (st.dotenv && st.dotenv.API_TOKEN));
    checks.push({
        name: 'API token',
        ok: !nonLoopback || tokenSet,
        warn: nonLoopback,
        detail: nonLoopback
            ? (tokenSet
                ? 'set - required because server.host is not loopback'
                : 'server.host=' + bindHost + ' is reachable from other machines - set API_TOKEN in harness/.env or the gateway will refuse to start')
            : 'not needed while bound to loopback',
    });

    checks.push({
        name: 'env shadowing',
        ok: true,
        warn: shadowed.length > 0,
        detail: shadowed.length ? `${shadowed.length} setting(s) come from an env var` : 'none',
    });

    const bashOn = get('features.bashAllowed').value;
    checks.push({
        name: 'bash gate',
        ok: true,
        warn: bashOn,
        detail: bashOn ? 'run_bash is ENABLED' : 'disabled (the default)',
    });

    A.clear();
    header(['Doctor']);
    const body = checks.map((c) => {
        const mark = c.ok ? A.green('✓') : A.red('✗');
        const warn = c.warn ? A.yellow(' ⚠') : '';
        return `${mark} ${A.bold(c.name)}${warn}\n  ${A.dim(c.detail)}`;
    });
    for (const l of A.boxLines('', body)) A.line(l);
    A.newline();
    const bad = checks.filter((c) => !c.ok).length;
    const warnings = checks.filter((c) => c.warn).length;
    await A.message(`${bad === 0 ? 'All required checks pass' : bad + ' check(s) failed'}`, [
        bad === 0
            ? (warnings ? A.yellow(`${warnings} warning(s) above — read them.`) : A.green('Nothing to fix.'))
            : 'Fix the ✗ items above, then run Doctor again.',
    ]);
}

// ── Non-interactive entry points (used by `webchat <subcommand>`) ──────────
function cmdStatus() {
    const st = state();
    const rows = rowsOf(st);
    const get = (p) => rows.find((r) => r.setting.path === p);
    const host = get('server.host').value || '127.0.0.1';
    const port = get('server.port').value || 8080;

    return D.probeGateway(host, port).then(async (gw) => {
        const cdp = await D.cdpAlive(Number(process.env.CDP_PORT || 9225));
        A.line(`${A.bold('webchat')}  ${get('webchat.mode').value}`);
        A.line(`  config   ${shortHome(st.file)}`);
        A.line(`  gateway  ${gw.up ? A.green(`up on ${host}:${port}`) : A.gray('stopped')}`);
        A.line(`  browser  ${cdp.up ? A.green(`CDP :${process.env.CDP_PORT || 9225}`) : A.gray('not running')}`);
        A.line(`  bash     ${get('features.bashAllowed').value ? A.red('ENABLED') : 'disabled'}`);
        return gw.up ? 0 : 1;
    });
}


  // ── webchat connect ────────────────────────────────────────────────────────
  //
  // The SECOND step, run in a different terminal once the CLI has launched the
  // browser and the user has signed in. It is deliberately non-interactive: the
  // decisions were already made in the TUI and stored in .webchat/connected.json,
  // so this just acts on them.
  //
  // What it does, in order:
  //   1. read the saved connection (which webchat, which browser target);
  //   2. confirm that browser is still up on the CDP port;
  //   3. start the gateway if it is not already running — the gateway ATTACHES to
  //      the browser that is already open (see findRunningBrowserWs in browser.js,
  //      attach-before-launch), so the signed-in session is what the model drives;
  //   4. start the agent the user chose, wired to the gateway.
  //
  // Every failure names the one command that fixes it, because the person running
  // this is in a fresh terminal with no context.
  // ── `webchat connect` — the executor ────────────────────────────────────────
//
// This runs the config the dashboard primed, and nothing else. It is deliberately
// NOT a second configurator: every choice lives in .webchat/launch.json, which the
// Launch screen shows along with the exact command it is about to run. When the two
// disagree the screen is right and this is the bug.
//
// `--dry-run` prints that plan without starting or launching anything, which is also
// how it is tested — spawning a real interactive agent is not something a test can
// assert on, but the plan it would execute is.
async function cmdConnect(argv) {
    //   --dry-run    print the plan, touch nothing
    //   --no-launch  do everything except hand the terminal to the harness. The
    //                plumbing (browsers, one gateway per gate, config files) is
    //                started for real, which is what a script or the MCP server
    //                wants — spawning an interactive TUI is not.
    const dryRun = argv.includes('--dry-run') || argv.includes('-n');
    const noLaunch = dryRun || argv.includes('--no-launch');
    const host = '127.0.0.1';

    const cfg = LC.read();
    const { gates: allGates } = G.read();
    const problems = [];

    if (!cfg.gates.length && !cfg.harnesses.length) {
        A.line('');
        A.line(`  ${A.red('Nothing is configured yet.')}`);
        A.line('');
        A.line('  Set it up in another terminal:');
        A.line(`      ${A.bold(A.cyan('webchat'))}`);
        A.line(`  then  ${A.bold('Webchats → Add a webchat')}  and  ${A.bold('Launch → Choose harness')}.`);
        A.line('');
        return 1;
    }

    const v = LC.validate(cfg, allGates);
    if (!v.ok) {
        A.line('');
        A.line(`  ${A.red('The saved launch config is not ready:')}`);
        for (const p of v.problems) A.line(`    ${A.gray('·')} ${p}`);
        A.line('');
        A.line(`  Fix it in ${A.bold('webchat')} → ${A.bold('Launch')}, then run this again.`);
        A.line('');
        return 1;
    }

    const chosen = cfg.gates.map((id) => allGates.find((g) => g.id === id)).filter(Boolean);
    const primary = chosen[0];
    const cwd = cfg.cwd && fs.existsSync(cfg.cwd) ? cfg.cwd : process.cwd();
    const env = H.envFor(chosen);

    A.line('');
    A.line(`  ${A.bold('webchat connect')}   ${A.dim(`${chosen.length} webchat(s) · ${cfg.harnesses.join(', ')} · ${cfg.mode}`)}`);
    A.line('');

    // ── one gateway per gate ────────────────────────────────────────────────
    // A gateway serves exactly one browser, so each selected gate needs its own.
    // Sharing one would send every model through whichever browser it attached to.
    for (const gate of chosen) {
        const cdp = await D.cdpAlive(gate.cdpPort);
        if (!cdp.up) {
            A.line(`  ${A.red('✗')} ${gate.label.padEnd(10)} browser not answering on CDP :${gate.cdpPort}`);
            A.line('');
            A.line(`  The window you signed into is gone. Re-open it:`);
            A.line(`      ${A.bold(A.cyan('webchat'))}   → Webchats → ${A.bold('Open the browser')}`);
            A.line('');
            return 1;
        }

        let gw = await D.probeGateway(host, gate.gatewayPort);
        if (!gw.up && dryRun) {
            A.line(`  ${A.yellow('·')} ${gate.label.padEnd(10)} gateway would start on :${gate.gatewayPort}`);
        } else {
            if (!gw.up) {
                A.line(`  ${A.dim('…')} ${gate.label.padEnd(10)} gateway starting on :${gate.gatewayPort}`);
                const res = D.startGateway({ port: gate.gatewayPort, cdpPort: gate.cdpPort });
                if (!res.started && res.reason !== 'already running') {
                    A.line(`  ${A.red('✗')} ${gate.label.padEnd(10)} gateway ${res.reason || 'could not start'}`);
                    A.line(`      see the log:  ${A.dim(shortHome(D.logFile(D.gatewayKey(gate.gatewayPort))))}`);
                    return 1;
                }
                for (let i = 0; i < 30 && !gw.up; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    gw = await D.probeGateway(host, gate.gatewayPort);
                }
            }
            if (!gw.up) {
                A.line(`  ${A.red('✗')} ${gate.label.padEnd(10)} gateway did not come up on ${host}:${gate.gatewayPort}`);
                A.line(`      see the log:  ${A.dim(shortHome(D.logFile(D.gatewayKey(gate.gatewayPort))))}`);
                return 1;
            }
            A.line(`  ${A.green('✓')} ${gate.label.padEnd(10)} CDP :${gate.cdpPort}  gateway http://${host}:${gate.gatewayPort}/v1`);
        }
    }

    // ── what each harness needs on disk ─────────────────────────────────────
    const launches = [];
    for (const hid of cfg.harnesses) {
        const h = H.harnessById(hid);
        if (!h) { problems.push(`unknown harness "${hid}"`); continue; }
        if (!H.installed(h) && !dryRun) {
            A.line(`  ${A.red('✗')} ${h.label}  not installed (${h.bin} is not on PATH)`);
            return 1;
        }
        if (!dryRun) {
            try { H.prepareConfigFiles(h, chosen, cwd, env, cfg.mode); } catch (e) {
                // Refusing to overwrite a stranger's config is a user decision, not a
                // crash — say which file and let them choose.
                A.line(`  ${A.red('✗')} ${h.label}  ${e.message}`);
                if (e.code === 'REFUSE_OVERWRITE') {
                    A.line(`      ${A.dim('Or set a different launch directory in')} ${A.bold('Launch')}${A.dim('.')}`);
                }
                return 1;
            }
        }
        launches.push({ h, argv: H.argvFor(h, cfg.mode) });
    }
    if (problems.length) {
        for (const p of problems) A.line(`  ${A.red('✗')} ${p}`);
        return 1;
    }

    A.line(`  ${A.green('✓')} model      ${env.HARNESS_MODEL_NAME}`);
    A.line(`  ${A.green('✓')} directory  ${shortHome(cwd)}`);
    A.line('');

    // Only worth saying when it would otherwise surprise someone: with one gate there
    // is nothing to explain, and `reason` is deliberately null.
    const reach = H.reachability(launches[0].h, chosen);
    if (reach.reason) {
        A.line(`  ${A.dim(reach.reason)}`);
        A.line('');
    }

    // ── hand the terminal to the first harness ──────────────────────────────
    // They are interactive programs, so exactly one can own this TTY. The rest are
    // printed as ready-to-paste commands rather than spawned blind.
    const first = launches[0];
    const rest = launches.slice(1);

    if (dryRun) {
        A.line(`  ${A.dim('dry run — nothing started')}`);
        for (const { h, argv } of launches) {
            A.line(`  ${A.gray(`${h.bin} ${argv.join(' ')}`.trim())}`);
        }
        A.line('');
        return 0;
    }

    if (noLaunch) {
        // Everything is up and wired; we simply do not take over the terminal.
        A.line(`  ${A.green('✓')} ready — nothing launched (--no-launch)`);
        for (const { h, argv } of launches) {
            A.line(`      ${A.cyan(`${h.bin} ${argv.join(' ')}`.trim())}`);
        }
        A.line('');
        D.writeConnection({
            gates: chosen.map((g) => ({ id: g.id, gatewayPort: g.gatewayPort, cdpPort: g.cdpPort })),
            agent: launches[0].h.id,
            mode: cfg.mode,
            cwd,
            connectedAt: new Date().toISOString(),
        });
        return 0;
    }

    A.line(`  ${A.dim('$')} ${first.h.bin} ${first.argv.join(' ')}`.trimEnd());
    A.line(`  ${A.gray('handing this terminal to it — Ctrl-C / exit to come back')}`);
    A.line('');

    if (rest.length) {
        A.line(`  ${A.bold('The other harness(es) need their own terminal:')}`);
        for (const { h, argv } of rest) {
            A.line(`      ${A.cyan(`${h.bin} ${argv.join(' ')}`.trim())}`);
        }
        A.line('');
    }

    D.writeConnection({
        gates: chosen.map((g) => ({ id: g.id, gatewayPort: g.gatewayPort, cdpPort: g.cdpPort })),
        agent: first.h.id,
        mode: cfg.mode,
        cwd,
        connectedAt: new Date().toISOString(),
    });

    // The agent owns the TTY from here, so the TUI must give it back first.
    D.restoreForExec();
    const { spawnSync } = require('child_process');
    const args = first.argv;
    const res = spawnSync(first.h.bin, args, {
        cwd,
        stdio: 'inherit',
        env: { ...process.env, ...env, HARNESS_MODE: cfg.mode },
    });
    if (res.error) {
        A.line(`  ${A.red('could not launch:')} ${res.error.message}`);
        return 1;
    }
    return res.status || 0;
}

module.exports = {
    screenDashboard, screenSite, screenSettings, screenGates, screenStart,
    screenLogs, screenDoctor, cmdStatus, cmdConnect,
};

// ── Interactive entry point ────────────────────────────────────────────────
async function interactive() {
    A.installGuards();
    for (;;) {
        let choice;
        try {
            choice = await screenDashboard();
        } catch (e) {
            if (e instanceof A.QuitError) break;
            throw e;
        }
          if (choice === A.BACK || choice === 'quit') break;
          try {
              // `site` is the old single-webchat screen; kept reachable so an older
              // habit still lands somewhere sensible, but the menu advertises Webchats.
              if (choice === 'site') await screenSite();
              else if (choice === 'webchats') await gatesScreens().screenGates();
              else if (choice === 'harnesses') await gatesScreens().screenHarnesses();
              else if (choice === 'mode') await gatesScreens().screenMode();
              else if (choice === 'plan') {
                  const next = await gatesScreens().screenPlan();
                  if (next === 'launch') return cmdConnect([]);
              } else if (choice === 'tools') await gatesScreens().screenTools();
              else if (choice === 'agentaccess') await screenAgentAccess();
              else if (choice === 'gates') await screenGates();
              else if (choice === 'settings') await screenSettings();
              else if (choice === 'start') await screenStart();
              else if (choice === 'logs') await screenLogs();
              else if (choice === 'doctor') await screenDoctor();
          } catch (e) {
            if (e instanceof A.QuitError) break;
            await A.message('Something went wrong', [
                A.red(e && e.message ? e.message : String(e)),
                '',
                A.dim('Your config was not modified by this error.'),
                A.dim('If it repeats, run Doctor from the main menu.'),
            ]);
        }
    }
    A.restore();
    A.clear();
    A.line(`  ${A.dim('bye')}`);
}

// ── Dispatch ───────────────────────────────────────────────────────────────
const USAGE = `
  ${A.bold('webchat')} — run any webchat (Gemini, ChatGPT, DeepSeek…) as an API

  ${A.bold('Two commands')}
    ${A.bold(A.cyan('webchat'))}          the dashboard: live status, and everything else
    ${A.bold(A.cyan('webchat connect'))}  in a NEW terminal — start the harness and your agent

    Everything is reachable from ${A.bold('webchat')}’s menu: choose the site, launch and
    log in, start the harness, change any setting, read the logs, run the doctor.

    ${A.bold('First run')}
      1. ${A.bold('webchat')}                    open the dashboard
      2. ${A.bold('Webchats → Add a webchat')}   pick the site, then "Open the browser"
      3. sign in to that window                 (you do this, not the CLI)
      4. ${A.bold('Webchats → Connect …')}       it checks the tab and records the webchat
      5. new terminal → ${A.bold('webchat connect')}   harness + agent, wired up

    ${A.bold('Several webchats at once')}
      Each one gets its own browser, profile and ports, so Gemini and ChatGPT can
      both be connected and used as separate models (${A.cyan('webchat/gemini')},
      ${A.cyan('webchat/chatgpt')}) from inside your agent.

    ${A.bold('Options')}
      webchat --help          this text
  `;
async function main(argv) {
    const cmd = argv[0];
    A.installGuards();

    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
        A.clear();
        A.line(USAGE);
        return 0;
    }

    // `status` is no longer a separate command — the owner asked for ONE command
    // that shows everything. It survives as a hidden alias so anything already
    // invoking it keeps working; it is not advertised in --help.
    if (cmd === 'status') { await interactive(); return 0; }

    if (cmd === 'connect' && argv[1] !== '--help') return cmdConnect(argv.slice(1));

    if (cmd === 'start') {
        A.installGuards();
        try {
            await screenStart();
        } catch (e) {
            if (!(e instanceof A.QuitError)) throw e;
        }
        A.restore();
        return 0;
    }
    if (cmd === 'doctor') {
        try { await screenDoctor(); } catch (e) { if (!(e instanceof A.QuitError)) throw e; }
        A.restore();
        return 0;
    }
    if (cmd === 'logs') {
        try { await screenLogs(); } catch (e) { if (!(e instanceof A.QuitError)) throw e; }
        A.restore();
        return 0;
    }
    if (cmd === 'settings') {
        try { await screenSettings(); } catch (e) { if (!(e instanceof A.QuitError)) throw e; }
        A.restore();
        return 0;
    }
    if (cmd === 'setup') {
        try { await screenSite(); } catch (e) { if (!(e instanceof A.QuitError)) throw e; }
        A.restore();
        return 0;
    }

    await interactive();
    return 0;
}

module.exports = { main, interactive };
