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
const A = require('./ansi.js');
const S = require('./settings.js');
const D = require('./daemon.js');
const G = require('./gates.js');
const H = require('./harnesses.js');
const LC = require('./launchconfig.js');
const screensGates = require('./screens-gates.js');
const { mcpSetupPrompt } = require('./mcp-setup.js');


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

// Pure, so the rule is testable without a terminal: what the dashboard is allowed to
// claim about the connection. `conn` is the resolved connection from resolveConnection(),
// which carries `live` from a real probe. Anything but a proven-live connection yields
// null — the caller then shows NOTHING rather than a reassuring label.
function connectionBadge(conn) {
    return conn && conn.live === true ? 'connected' : null;
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
        conn: null, at: new Date(), err: null,
    };

    // Is the RECORDED connection actually live right now?
    //
    // `connected.json` is written when the user confirms a tab, and NOTHING ever clears it
    // (clearConnection is defined and never called), so reading it alone reported
    // "connected" for a browser that had been closed. The Webchats list has always
    // re-verified with G.refresh(); the header did not, so the two contradicted each other
    // on the same screen.
    //
    // The rule is the gate list's own rule (G.live): the browser answers, a tab for the
    // site exists, it has a composer, and the page carries no sign-in copy. Using the same
    // standard means the header and the list can never disagree. Cached inside G, so a
    // 2s redraw does not open a browser connection every time.
    async function resolveConnection() {
        const recorded = D.readConnection();
        if (!recorded || !Array.isArray(recorded.gates) || !recorded.gates.length) return null;
        const want = recorded.gates[0];
        const reg = G.read();
        // Match by id, and fall back to the port: the oldest writer recorded no gate name,
        // only the CDP port, and normalisation deliberately keeps it `null` rather than
        // inventing one.
        const gate = (reg.gates || []).find((g) => want.id && g.id === want.id)
            || (reg.gates || []).find((g) => want.cdpPort && g.cdpPort === want.cdpPort);
        if (!gate) return { ...recorded, live: false, why: 'that webchat is no longer configured' };
        let state;
        try {
            state = await G.liveCached(gate, 30000);
        } catch (e) {
            state = { live: false, why: (e && e.message) || 'could not be checked' };
        }
        return { ...recorded, live: Boolean(state.live), why: state.live ? null : state.why };
    }

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
            // cdpAlive reports whether the debug port answers and nothing about tabs —
            // its shape is { up, info }. The render below reads a tab count, so ask for the
            // targets too, and give pages a real (empty) array either way.
            //
            // Without this the render threw `Cannot read properties of undefined (reading
            // 'length')` on every machine where the browser WAS running — and the menu
            // swallows a failing tick, so the whole status panel silently vanished from the
            // dashboard, which is the main screen. Measured: no `gateway`/`stopped` line ever
            // reached the terminal while the browser was up.
            if (snap.cdp && snap.cdp.up) {
                try {
                    const t = await D.cdpTargets(cdpPort);
                    snap.cdp.pages = (t && Array.isArray(t.pages)) ? t.pages : [];
                } catch { snap.cdp.pages = []; }
            } else if (snap.cdp) {
                snap.cdp.pages = [];
            }
            snap.conn = await resolveConnection();
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
        // LIVE, never the recorded file: a connection that has gone away must not read as
        // connected. When it is not live, show nothing rather than a reassuring label.
        const conn = snap.conn && snap.conn.live ? snap.conn : null;

        const body = [];
        body.push(`${A.dim('gateway')}    ${snap.gw.up
            ? A.green(`up  http://${host}:${port}`)
            : A.gray('stopped')}${m && m.uptimeMs != null ? A.gray(`   up ${fmtDuration(m.uptimeMs)}`) : ''}`);
        body.push(`${A.dim('browser')}    ${snap.cdp.up
            ? A.green(`running, CDP :${cdpPort}`) + A.gray(`  ${(snap.cdp.pages || []).length} tab(s)`)
            : A.gray('not running')}`);
        body.push(`${A.dim('webchat')}    ${A.bold(m ? m.model || '—' : (get('webchat.mode').value || '—'))}`
            + (connectionBadge(conn) ? A.green('   connected') : ''));

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

      // The count says how many are USABLE, not how many were once marked connected: a
      // session that has expired must not read as ready. Cached - this loop redraws
      // every couple of seconds.
      const gatesNow = await G.refresh(undefined, 30000);
      const liveNow = gatesNow.gates.filter((g) => g.connected);
      const cfg = LC.read();
      const ready = LC.validate({ ...cfg, gates: cfg.gates.filter((id) => liveNow.some((g) => g.id === id)) }, liveNow);
      const items = [
      { label: 'Webchats', hint: liveNow.length ? `${liveNow.length} connected · ${gatesNow.gates.length} configured` : `nothing connected yet · ${gatesNow.gates.length} configured`, value: 'webchats' },
          { label: 'Agentic harness', hint: cfg.harnesses.length ? cfg.harnesses.join(', ') : 'choose which agent to run', value: 'harnesses' },
          { label: 'Permission mode', hint: cfg.mode + (cfg.mode === 'yolo' ? ' — no gate at all' : ''), value: 'mode' },
          { label: ready.ok ? 'Launch' : 'Launch (not ready yet)', hint: ready.ok ? LC.summarize(cfg) : ready.problems[0], value: 'plan' },
          { label: 'Tools', hint: 'switch individual tools on or off', value: 'tools' },
          { label: 'Config', hint: 'every setting, grouped, with the source it resolves from', value: 'settings' },
          { label: 'Agent access (MCP)', hint: 'let any agent drive this harness', value: 'agentaccess' },
          { label: 'Logs', hint: 'gateway output, with a one-click bug report', value: 'logs' },
          { label: 'Doctor', hint: 'check everything and report', value: 'doctor' },
            { label: 'Tour', hint: 'the guided walkthrough, any time', value: 'tutorial' },
          { label: 'Back to the start', hint: 'the greeting, the question and the tour', value: 'restart' },
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
          // The same live rule as the dashboard header. This screen already probes the
          // browser on the line above, so reading the recorded file here let one frame
          // claim "browser: not running" AND "connected" at once.
          const recorded = D.readConnection();
          let connLive = false;
          let connWhy = null;
          if (recorded && Array.isArray(recorded.gates) && recorded.gates.length) {
              const reg = G.read();
              const gate = (reg.gates || []).find((g) => g.id === recorded.gates[0].id);
              if (!gate) {
                  connWhy = 'that webchat is no longer configured';
              } else {
                  let stt;
                  try { stt = await G.liveCached(gate, 30000); } catch (e) { stt = { live: false, why: (e && e.message) || 'could not be checked' }; }
                  connLive = Boolean(stt.live);
                  connWhy = stt.live ? null : stt.why;
              }
          }
          const body = [
              `${A.dim('selected')}  ${A.bold(modeRow.value || '(unset)')}`,
              `${A.dim('browser')}   ${cdp.up ? A.green(`running on CDP :${cdpPort}`) : A.gray('not running')}`,
              `${A.dim('profile')}   ${shortHome(D.profileDir())}`,
              `${A.dim('connected')} ${connLive
                  ? A.green(`${recorded.mode}${recorded.agent ? ` → ${recorded.agent}` : ''}`)
                  : A.gray(connWhy ? `no — ${connWhy}` : 'not yet — launch, log in, then Connect')}`,
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

      // Record what was connected, for `webchat start`.
      // Keeping the previously chosen agent means the second command never has to
      // ask again — it acts on the decision already made here.
      const prev = D.readConnection() || {};
      // Record the gate in the CANONICAL shape so every reader (the dashboard header, the
      // launcher, the MCP) sees the same thing. This used to omit `gates` entirely, which
      // read back as "nothing connected" after a successful connect.
      const reg = G.read();
      const gcfg = (reg.gates || []).find((g) => g.cdpPort === port);
      D.writeConnection({
          gates: gcfg ? [{ id: gcfg.id, gatewayPort: gcfg.gatewayPort, cdpPort: gcfg.cdpPort }] : [],
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
          `    ${A.bold(A.cyan('webchat start'))}`,
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
                  hint: `${g.settings.length} setting(s)${g.settings.some((s) => s.risk) ? '  ' + A.yellow('has guardrails') : ''}`,
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
          // EVERY setting is shown. The basic/advanced split was a lie of omission: a
          // setting hidden behind a toggle is one the owner cannot find, and the ones
          // marked "advanced" here are exactly the ones you reach for when something is
          // wrong. `advanced` is still read for nothing — the flag no longer hides.
          const visible = rows;

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
          items.push({ label: 'Back', value: 'back' });

          const pick = await A.menu(items, { title: group.title });
          if (pick === A.BACK || pick === 'back') return;
          await editSetting(pick);
      }
  }

  // ── Per-webchat prompts ────────────────────────────────────────────────────
  // Dedicated screen, because the value is a MAP keyed by webchat id and a single JSON
  // textarea could not say which webchat was being edited — the old field rendered the
  // whole object as "[object Object]" and offered no picker at all. Here the webchats are
  // listed by name, the ones with an override are marked, and the prompt for each is
  // edited in the multi-line editor. Clearing a prompt removes the override.
  async function screenPerModePrompts(setting) {
      for (;;) {
          const st = state();
          const raw = st.raw || {};
          const modes = S.listModes(raw);
          const map = S.getPath(raw, setting.path) || {};
          const globalPrompt = S.getPath(raw, 'systemPrompt.text') || '';

          A.clear();
          header(['System prompt', 'Per-webchat']);
          const body = [
              globalPrompt
                  ? `${A.dim('fallback')}  the shared prompt above applies to any webchat without an override`
                  : `${A.dim('fallback')}  ${A.yellow('no shared prompt set')} — the harness built-in is used where there is no override`,
              '',
          ];
          const ids = modes.map((m) => m.id);
          for (const id of ids) {
              const has = typeof map[id] === 'string' && map[id].trim() !== '';
              body.push(`${has ? A.green('●') : A.gray('○')} ${A.bold(id)}  ${
                  has ? A.dim(`${map[id].length} chars`) : A.gray('no override — uses the fallback')}`);
          }
          if (!ids.length) {
              body.push(A.yellow('No webchats are configured yet.'));
              body.push(A.gray('Add one in Webchats first, then come back.'));
          }
          const orphans = Object.keys(map).filter((k) => !ids.includes(k));
          if (orphans.length) {
              body.push('');
              body.push(A.yellow(`⚠ override(s) for webchats that no longer exist: ${orphans.join(', ')}`));
              body.push(A.gray('  They stay until you clear them here — they may be from a renamed webchat.'));
          }
          for (const l of A.boxLines('Per-webchat prompts', body)) A.line(l);
          A.newline();

          const items = ids.map((id) => ({
              label: id,
              hint: (typeof map[id] === 'string' && map[id].trim()) ? 'has an override' : 'uses the fallback',
              value: id,
          }));
          for (const o of orphans) items.push({ label: o, hint: 'orphaned override', value: o });
          items.push({ label: 'Back', value: 'back' });

          const pick = await A.menu(items, { title: 'Which webchat?' });
          if (pick === A.BACK || pick === 'back') return;

          const current = typeof map[pick] === 'string' ? map[pick] : '';
          const edited = await A.longText(`Prompt for ${pick}`, {
              default: current,
              defaultValue: '',
              hint: 'Blank uses the shared prompt above. Ctrl-D clears, Ctrl-S saves.',
          });
          if (edited === A.BACK) continue;

          const { raw: fileRaw, file } = S.loadRaw();
          const nextMap = Object.assign({}, S.getPath(fileRaw, setting.path) || {});
          if (String(edited).trim() === '') delete nextMap[pick];
          else nextMap[pick] = edited;
          S.setPath(fileRaw, setting.path, nextMap);
          S.saveRaw(fileRaw, file);

          await A.message('Saved', [
              nextMap[pick]
                  ? `${pick} now has its own prompt (${nextMap[pick].length} chars).`
                  : `${pick} now uses the shared prompt.`,
              '',
              A.dim('A running gateway picks this up on restart.'),
          ]);
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
      // "Reset" only appeared when the value came from the FILE, so a setting sitting at a
      // built-in default had no reset entry at all, and one set by an env var had none
      // either. There is now always a way back to the built-in default, and it says which
      // layers it will strip (file value and/or the overriding env var) before it acts.
      const fromFile = row.source === 'file' || row.shadowedFileValue !== undefined;
      items.push({
          label: 'Reset to default',
          hint: fromFile || row.shadowedBy
              ? `back to ${A.truncate(S.display(setting, setting.default), 30)}`
              : 'already at the default',
          value: '__reset_default',
      });
      items.push({ label: 'Back', value: 'back' });

      const action = await A.menu(items, { title: setting.label });
      if (action === A.BACK || action === 'back') return;

      if (action === '__reset_default') {
          const what = [];
          if (fromFile) what.push(`remove ${setting.path} from the config file`);
          if (row.shadowedBy) what.push(`remove ${row.shadowedBy} from ${path.basename(st.dotenvFile)}`);
          const ok = await A.confirm('Reset to default', [
              `${setting.label} → ${S.display(setting, setting.default)}`,
              ...(what.length ? ['', 'This will:', ...what.map((w) => `  • ${w}`)] : []),
              '',
              'Settings are backed up before they are written.',
          ]);
          if (!ok) return;
          if (fromFile) {
              const { raw, file } = S.loadRaw();
              S.setPath(raw, setting.path, undefined);
              S.saveRaw(raw, file);
          }
          if (row.shadowedBy) {
              const text = fs.readFileSync(st.dotenvFile, 'utf-8');
              fs.writeFileSync(st.dotenvFile, S.removeEnvVar(text, setting.env), { mode: 0o600 });
          }
          await A.message('Reset', [`${setting.label} is now ${S.display(setting, setting.default)}.`]);
          return;
      }

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

      let next;
      if (setting.type === 'bool' || setting.type === 'tooltoggle') {
          // A tool toggle is on/off like a bool; its storage shape (membership of
          // tools.disabled) is handled by saveSetting, so it edits the same way.
          next = await A.menu([{ label: 'On', value: true }, { label: 'Off', value: false }], { title: setting.label });
          if (next === A.BACK) return;
      } else if (setting.type === 'choice') {
        // A fixed set, picked from a menu. This is what makes headed/headless an
        // actual choice: a free-text field you have to spell exactly right is how a
        // setting looks applied and silently falls back to the default.
        const opts = (setting.options || []).map((o) => ({
            label: String(o),
            hint: String(o) === String(row.value) ? 'current' : '',
            value: String(o),
        }));
        next = await A.menu(opts.concat([{ label: 'Back', value: 'back' }]), { title: setting.label });
        if (next === A.BACK || next === 'back') return;
      } else if (setting.type === 'mode') {
          const modes = S.listModes(st.raw).map((m) => ({ label: m.id, hint: m.url, value: m.id }));
          next = await A.menu(modes.concat([{ label: 'Back', value: 'back' }]), { title: 'Webchat' });
          if (next === A.BACK || next === 'back') return;
      } else if (setting.type === 'permode') {
          // Straight into its own screen and return: the map is not a scalar, so there is
          // nothing for the generic "change value" flow below to do with it.
          await screenPerModePrompts(setting);
          return;
      } else if (setting.type === 'longtext') {
          // A longtext value is multi-line by nature. Routing it through prompt() — a
          // single-line editor — printed the whole thing as one raw run of text straight
          // through the frame, which is why editing the system prompt looked broken. The
          // editor also gets the built-in default so Ctrl-D can restore it in place.
          const cur = row.value === undefined || row.value === null
              ? ''
              : (Array.isArray(row.value) ? row.value.join(', ') : String(row.value));
          const deflt = setting.default === undefined || setting.default === null
              ? ''
              : (Array.isArray(setting.default) ? setting.default.join(', ') : String(setting.default));
          next = await A.longText(setting.label, {
              default: cur,
              defaultValue: deflt,
              hint: setting.help,
              validate: setting.validate,
          });
          if (next === A.BACK) return;
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
        const mem = require('../src/runtime/memory');
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
    // The port the gateway ACTUALLY ends up on. startGateway renumbers when the configured
    // one is held by something else, and every probe below has to follow it.
    let usePort = port;
    let gw = await D.probeGateway(host, port);
    if (gw.up) {
        A.line(`  ${A.green('✓')} gateway already up on ${host}:${port}`);
    } else {
        A.line(`  ${A.dim('gateway')}  starting…`);
        // awaited: startGateway verifies the port is free first and renumbers if it is
        // taken, so the answer (and the port) only exists once that check has run.
        const res = await D.startGateway();
        if (!res.started && res.reason !== 'already running') {
            A.newline();
            await A.message('Could not start the gateway', [A.red(res.reason || 'unknown error')]);
            return;
        }
        // It may have moved off the requested port to avoid a squatter.
        if (res.port && res.port !== port) {
            A.line(`  ${A.yellow('·')} port ${port} was in use — started on ${res.port} instead`);
            usePort = res.port;
        }
        for (let i = 0; i < 24; i++) {
            await new Promise((r) => setTimeout(r, 500));
            gw = await D.probeGateway(host, usePort);
            if (gw.up) break;
            A.write('.');
        }
        A.newline();
        if (!gw.up) {
            await A.message('Gateway did not come up', [
                `Nothing answered on ${host}:${usePort} after 12s.`,
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
        `${A.dim('gateway')}   ${A.green(`up on http://${host}:${usePort}`)}`,
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
            A.dim('  ./scripts/launch-agent.sh opencode|claude|codex|aider|hermes|crush|any'),
        ]);
        return;
    }
    await screenLaunchIde(host, port, rows);
}

async function screenLaunchIde(host, port, rows) {
    const launcher = path.join(D.REPO, 'scripts', 'launch-agent.sh');
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
    A.line(`  ${A.dim('$')} ./scripts/launch-agent.sh ${pick}`);
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
async function collectDiagnostics(extra = {}) {
    const st = state();
    const rows = rowsOf(st);
    // Refreshed, not read: this is a PROBLEM REPORT, and a stale `connected` flag makes the
    // report describe a harness the user does not have. It is the one artifact that has to
    // be honest, because it is what gets pasted into a bug report.
    const gates = await G.refresh(undefined, 0);
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
    // await: collectDiagnostics probes the gates live now, so a report cannot describe a
    // harness state that has already gone away.
    const diag = await collectDiagnostics(extra);
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
    const serverPath = path.join(__dirname, '..', 'src', 'tools', 'mcp-server.js');
    let toolCount = 0;
    try {
        toolCount = require('../src/tools/mcp-server').TOOLS.length;
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
        { label: 'Copy a setup prompt for my agent', hint: 'it wires this up for you', value: 'prompt' },
        { label: 'Copy the config block', hint: 'paste it into your agent', value: 'copy' },
        { label: 'List the tools', hint: `${toolCount} available`, value: 'list' },
        { label: 'Back', value: 'back' },
    ], { title: '' });

    if (choice === 'prompt') {
        await screenMcpSetupPrompt();
        return screenAgentAccess();
    }
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
        try { tools = require('../src/tools/mcp-server').TOOLS; } catch { /* shown empty */ }
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

// ── Agent setup prompt (MCP) ───────────────────────────────────────────────
//
// A prompt the user copies into THEIR OWN agent so that agent wires this harness up as an
// MCP server. We cannot write into another product's config: the client may be on another
// machine (that is what the platform question a screen earlier is about), its config path
// and schema vary by client and version, and guessing wrong leaves a server that never
// starts with no error anywhere. An agent on the user's machine can read that config and
// write it correctly, so the deliverable is a briefing for it.
//
// The platform this install is configured for, or '' when it has never been answered.
//
// ONE definition, because this rule was written twice and the two copies disagreed:
// resolveAll() returns an ARRAY of resolved rows, so reading `.platform` off it is always
// undefined. Site A (the platform screen) was fixed to use .find(); site B (the MCP setup
// prompt, below) still read the array, so a Windows user was handed a Linux briefing with
// POSIX paths — a setup that fails with a parse error the user cannot interpret.
function currentPlatform() {
    try {
        const row = S.resolveAll().find((r) => r.setting.path === 'platform');
        return row && row.value !== undefined && row.value !== null ? String(row.value) : '';
    } catch {
        return '';   // unset is a legitimate state, not an error to guess around
    }
}

// The prompt is PLATFORM-AWARE. It is generated from the answer the user just gave, because
// that answer decides the shell, the path separators, and whether a path must be escaped
// inside JSON - and a Windows path handed to a POSIX agent is a setup that fails with a
// parse error the user cannot interpret.
async function screenMcpSetupPrompt(platformOverride) {
    const platform = platformOverride === 'windows' ? 'windows'
        : platformOverride === 'linux' ? 'linux'
            : (currentPlatform() || 'linux');
    const serverPath = path.join(__dirname, '..', 'src', 'tools', 'mcp-server.js');
    let toolCount = 0;
    try { toolCount = require('../src/tools/mcp-server').TOOLS.length; } catch { /* reported as 0, not guessed */ }

    const build = () => mcpSetupPrompt({ platform, serverPath, toolCount });
    const outFile = path.join(D.stateDir(), 'mcp-setup-prompt.md');

    const save = () => {
        try {
            D.ensureStateDir();
            fs.writeFileSync(outFile, build(), { mode: 0o600 });
            return { ok: true, file: outFile };
        } catch (e) { return { ok: false, reason: e && e.message }; }
    };

    A.clear();
    header(['Agent setup prompt', 'MCP']);
    const shown = shortHome(outFile);
    for (const l of A.boxLines('Let your own agent wire this up', [
        'This builds a prompt you paste into YOUR agent - Claude Code, opencode,',
        'Cursor, any agent with MCP support. That agent reads its own config and',
        `registers this harness as an MCP server (${toolCount} tools).`,
        '',
        `Written for ${platform === 'windows' ? 'Windows (cmd.exe, backslashes)' : 'Linux (bash, forward slashes)'} from your platform answer.`,
        '',
        `Copy it, or read ${shown}`,
    ])) A.line(l);
    A.newline();

    const choice = await A.menu([
        { label: 'Copy the prompt', hint: 'paste it into your agent', value: 'copy' },
        { label: 'Save it to a file', hint: shown, value: 'save' },
        { label: 'Preview it', hint: `${build().length} characters`, value: 'preview' },
        { label: 'Back', value: 'back' },
    ], { title: '' });

    if (choice === 'copy') {
        const res = D.copyToClipboard ? D.copyToClipboard(build()) : { ok: false, reason: 'no clipboard helper' };
        // A clipboard copy is the request; the file is the fallback for when it fails, so a
        // failed copy still leaves the user with the prompt rather than with nothing.
        const saved = res.ok ? null : save();
        await A.message(res.ok ? 'Copied' : 'Could not copy', res.ok
            ? ['Paste it into your agent and let it do the setup.']
            : [A.red(res.reason || 'clipboard unavailable'),
                saved && saved.ok
                    ? `The prompt is at ${shortHome(saved.file)} - open and copy it from there.`
                    : 'and it could not be written to a file either.']);
        return screenMcpSetupPrompt(platform);
    }
    if (choice === 'save') {
        const res = save();
        await A.message(res.ok ? 'Saved' : 'Could not save', res.ok
            ? [`${shortHome(res.file)}`, 'Open it and copy the whole thing into your agent.']
            : [A.red(res.reason || 'write failed')]);
        return screenMcpSetupPrompt(platform);
    }
    if (choice === 'preview') {
        A.clear();
        header(['Agent setup prompt', 'preview']);
        const text = build();
        const lines = text.split('\n');
        // The prompt is longer than any terminal, so show a head and say so rather than
        // truncating silently and letting the user think that is all of it.
        const room = Math.max(8, A.termHeight() - 6);
        for (const l of lines.slice(0, room)) A.line('  ' + A.gray(A.truncate(l, A.termWidth() - 6)));
        A.newline();
        A.line(A.gray(`  ... ${lines.length - room} more lines (${text.length} characters total). Use Copy or Save for the whole thing.`));
        A.newline();
        A.line(A.gray('  any key to go back'));
        await A.readKey();
        return screenMcpSetupPrompt(platform);
    }
    return A.BACK;
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

    const launcher = path.join(D.REPO, 'scripts', 'launch-agent.sh');
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


  // ── webchat start ────────────────────────────────────────────────────────
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
  // ── `webchat start` — the executor ────────────────────────────────────────
//
// This runs the config the dashboard primed, and nothing else. It is deliberately
// NOT a second configurator: every choice lives in .webchat/launch.json, which the
// Launch screen shows along with the exact command it is about to run. When the two
// disagree the screen is right and this is the bug.
//
// `--dry-run` prints that plan without starting or launching anything, which is also
// how it is tested — spawning a real interactive agent is not something a test can
// assert on, but the plan it would execute is.
async function cmdStart(argv) {
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

    // ── configure it ourselves rather than sending the user away ────────────
    //
    // This used to print "Nothing is configured yet" and tell the user to go and set it
    // up in another terminal. The point of `connect` is that it just connects: anything
    // the machine can answer for itself, it answers. A gate that is already connected and
    // a harness that is already installed are both facts, not preferences, so they are
    // filled in and the launch proceeds.
    if (!cfg.gates.length || !cfg.harnesses.length) {
        // Only gates that are live RIGHT NOW are candidates. A stale `connected: true`
        // pointed the agent at a tab that could never answer.
        const usable = await G.liveGates(0);
        const { cfg: filled, filled: auto } = LC.autofill(cfg, usable, H.firstInstalled);
        if (Object.keys(auto).length) {
            Object.assign(cfg, LC.write(filled));
            A.line('');
            A.line(`  ${A.dim('nothing was configured — filled in')} ${A.bold(Object.entries(auto)
                .map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · '))}`);
        }
    }

    if (!cfg.gates.length) {
        // A webchat cannot be invented: it is an account someone has to sign into.
        A.line('');
        A.line(`  ${A.red('No webchat yet.')}`);
        A.line('');
        A.line('  Add one - it opens a browser for you to log into:');
        A.line(`      ${A.bold(A.cyan('webchat'))}   →  ${A.bold('Webchats → Add a webchat')}`);
        A.line('');
        A.line(`  ${A.dim('That is the only step only you can do; everything after it is automatic.')}`);
        A.line('');
        return 1;
    }
    if (!cfg.harnesses.length) {
        A.line('');
        A.line(`  ${A.red('No agentic harness found on PATH.')}`);
        A.line('');
        A.line('  Install one of these, then run this again:');
        A.line(`      ${A.dim('opencode')}  ·  ${A.dim('claude')}  ·  ${A.dim('aider')}`);
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

    const liveNow = await G.liveGates(0);
    const liveIds = new Set(liveNow.map((g) => g.id));
    const chosen = cfg.gates.map((id) => allGates.find((g) => g.id === id)).filter(Boolean);
    const dead = chosen.filter((g) => !liveIds.has(g.id));
    if (dead.length) {
        A.line('');
        A.line(`  ${A.red('✗')} ${dead.map((g) => g.label).join(', ')} ${dead.length > 1 ? 'are' : 'is'} not signed in.`);
        A.line('');
        A.line('  A webchat is only usable while its tab is signed in and answering.');
        A.line(`      ${A.bold(A.cyan('webchat'))}   →  ${A.bold('Webchats')}  →  ${A.bold('Open the browser')}  →  sign in`);
        A.line('');
        return 1;
    }
    const primary = chosen[0];
    const cwd = cfg.cwd && fs.existsSync(cfg.cwd) ? cfg.cwd : LC.ensureAgentDir();
    const env = H.envFor(chosen);

    A.line('');
    A.line(`  ${A.bold('webchat start')}   ${A.dim(`${chosen.length} webchat(s) · ${cfg.harnesses.join(', ')} · ${cfg.mode}`)}`);
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
                // awaited: it verifies the port is free and renumbers if something else
                // holds it, so the port to probe is only known after this resolves.
                const res = await D.startGateway({ port: gate.gatewayPort, cdpPort: gate.cdpPort, profile: gate.profile, mode: gate.site });
                if (!res.started && res.reason !== 'already running') {
                    A.line(`  ${A.red('✗')} ${gate.label.padEnd(10)} gateway ${res.reason || 'could not start'}`);
                    A.line(`      see the log:  ${A.dim(shortHome(D.logFile(D.gatewayKey(res.port || gate.gatewayPort))))}`);
                    return 1;
                }
                // PERSIST the renumber. Leaving the gate on a port we are not listening on
                // would point the harness, the hub and every later `webchat start` at a
                // number nothing serves — the fix would just move the failure.
                if (res.port && res.port !== gate.gatewayPort) {
                    A.line(`  ${A.yellow('·')} ${gate.label.padEnd(10)} port ${gate.gatewayPort} was in use — renumbered to ${res.port}`);
                    try { G.update(gate.id, { gatewayPort: res.port }); gate.gatewayPort = res.port; } catch { /* keep the old number rather than fail the launch */ }
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

    // ── one url in front of every selected webchat ──────────────────────────
    // Each webchat needs its own browser, so each keeps its own gateway. The hub turns
    // those sub urls back into ONE url for the user: /v1/models lists every webchat and
    // every toggle combination, and each request is forwarded to the gateway that owns
    // it. With a single webchat there is nothing to route, so it is only started when
    // it would actually help.
    let hubPort = 0;
    if (!dryRun && chosen.length > 1) {
        const pair = await G.freePortPair();
        // awaited: startHub verifies the port is free and renumbers if it is not. The
        // harness env below must be pointed at the port that ACTUALLY bound.
        const res = await D.startHub({ port: pair.gatewayPort });
        if (res.started) {
            hubPort = res.port || pair.gatewayPort;
            A.line(`  ${A.green('✓')} hub        one url for all ${chosen.length} webchats on http://${host}:${hubPort}/v1`);
        } else {
            A.line(`  ${A.yellow('·')} hub        not started (${res.reason || 'unknown'}) — falling back to the first webchat`);
        }
    }
    if (hubPort) env = H.envFor(chosen, { modelName: env.HARNESS_MODEL_NAME, hubPort });

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
        launches.push({ h, argv: H.argvFor(h, cfg.mode, cfg.args, env) });
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
    const reach = H.reachability(launches[0].h, chosen, hubPort);
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

    // ── give the agent its OWN window ───────────────────────────────────────
    //
    // The agent is an interactive TUI, and handing it this terminal replaced the CLI -
    // so the user lost the thing they were just using. It gets its own window now and
    // this terminal stays a CLI.
    const started = D.launchInTerminal({
        bin: first.h.bin,
        argv: first.argv,
        cwd,
        env: { ...env, ...H.isolateHarnessEnv(cwd), HARNESS_MODE: cfg.mode },
    });
    if (!started.ok) {
        A.line(`  ${A.red('could not launch:')} ${started.error}`);
        return 1;
    }
    if (started.how === 'window') {
        A.line(`  ${A.green('✓')} ${first.h.label} opened in a new ${started.terminal} window`);
        A.line(`  ${A.dim('this terminal stays yours — the webchat CLI is still here')}`);
    } else {
        A.line(`  ${A.green('✓')} ${first.h.label} started in the background`);
        A.line(`  ${A.dim('log:')} ${shortHome(started.log)}`);
    }
    A.line('');
    return 0;
}

// ── Interactive entry point ────────────────────────────────────────────────
// ── The greeting ────────────────────────────────────────────────────────────
//
// Three beats, in this order, because each one is a question the next depends on:
//   1. who this is, with the character waving, so the first thing on screen explains
//      the tool rather than asking the user something they cannot answer yet;
//   2. which system the agent runs on;
//   3. how much of the tour they want.
//
// The block goes through the menu's `above` hook, NOT drawn beforehand: menu() clears
// the screen on every redraw, so anything drawn first is wiped before it can be read.
// `above` may be a function, which is what keeps the character MOVING while the menu
// waits.
async function screenWelcome() {
    const SK = require('./stickman.js');

    // Friendly, and detailed enough to answer the three questions someone actually has
    // in the first ten seconds: what is this, does it work with my setup, and what does
    // it cost me. Wrapped to a column so the character keeps his place beside it.
    const intro = [
        'Hey - welcome to the webchat-to-api harness.',
        '',
        'It turns any AI webchat you have - free or paid - into an ordinary model API.',
        '',
        'Puppeteer drives a tab you sign in to; a system prompt makes it answer like an '
            + 'endpoint.',
        '',
        'Point Claude Code, opencode or Codex at it - free or paid, no API key.',
        '',
        'This CLI is the control centre; MCP lets an agent drive it.',
    ];

    let tick = 0;

    // The greeting has to FIT. It was authored at 26 rows against a 24-row terminal once
    // the menu was reserved, so the top scrolled away and the first thing anyone saw was
    // the middle of a paragraph - which is what "the CLI looks broken" looked like.
    // Measuring by hand got this wrong twice, so the block measures ITSELF now: if the
    // paragraphs do not fit the rows it has, it drops whole ones from the end until they
    // do. Whole paragraphs, never a half-sentence, and the first line always survives.
    const RESERVE = 9;    // measured in a real 76x24 pane: box + blank line + footer
    // The greeting is authored as loose lines with '' between them; turn that into
    // paragraphs once so the shrinker can drop whole ones.
    const asParas = () => {
        const out = []; let cur = [];
        for (const line of intro) {
            if (line === '') { if (cur.length) out.push(cur.join(' ')); cur = []; }
            else cur.push(line);
        }
        if (cur.length) out.push(cur.join(' '));
        return out;
    };

    const build = (paras) => {
        const art = SK.frameFor('wave', tick);
        const COL = Math.max(28, Math.min(64, A.termWidth() - 26));
        const wide = A.termWidth() >= COL + 24;
        const text = [];
        paras.forEach((para, i) => {
            const wrapped = A.wrapText(para, COL);
            for (const w of wrapped) text.push(i === 0 && w === wrapped[0] ? A.bold(w) : w);
            if (i < paras.length - 1) text.push('');
        });
        // Centre him against the paragraph: pinned to the top he stands beside the first
        // nine lines and the rest of the greeting runs on without him.
        const offset = wide ? Math.max(0, Math.floor((text.length - art.length) / 2)) : -1;
        const rows = [];
        for (let i = 0; i < text.length; i++) {
            const a = wide && i >= offset && i - offset < art.length ? art[i - offset].padEnd(19) : '';
            const s = text[i] || '';
            rows.push(s ? `${A.padVisible('  ' + s, COL + 5)}${a}`.replace(/\s+$/, '')
                        : (a.trim() ? `${' '.repeat(COL + 5)}${a}`.replace(/\s+$/, '') : ''));
        }
        return A.centerBlock(rows, { reserve: RESERVE });
    };

    const draw = () => {
        let paras = asParas();
        let rows = build(paras);
        // Drop the MIDDLE paragraph, not the tail: the how-it-works line is the one a user
        // can afford to lose on a short terminal. The pricing and MCP lines are what they
        // are deciding on, so those go last.
        while (rows.length + RESERVE > A.termHeight() && paras.length > 3) {
            paras = paras.filter((_, i) => i !== Math.min(2, paras.length - 2));
            rows = build(paras);
        }
        return rows;
    };

    // resolveAll() returns an ARRAY of resolved rows, not an object — so this used to read
    // `.platform` off an array, which is always undefined. Two consequences, both silent:
    // the "(current)" marker below never rendered on any launch (a display that could not
    // show which value was in force), and the one-off setup prompt was shown to EVERY user
    // on EVERY launch instead of only to someone who has not answered the question yet.
    let current = '';
    try {
        current = currentPlatform();
    } catch { /* unset is fine */ }
    const mine = (v) => (current === v ? '   (current)' : '');

    const pick = await A.menu([
        { label: 'Linux', hint: `bash, forward slashes, POSIX rules${mine('linux')}`, value: 'linux' },
        { label: 'Windows', hint: `cmd.exe, backslashes, Windows rules${mine('windows')}`, value: 'windows' },
    ], {
        title: 'Which system is your agent running on?',
        above: draw,
        tickMs: 180,
        // He waves the WHOLE time. This used to stop after twenty-four ticks and settle
        // into a still frame, which is why he looked frozen: by the time anyone had read
        // the paragraph he had already stopped.
        onTick: () => { tick++; return []; },
        footer: ['Your agent may be on another machine - this sets its shell and paths.'],
    });

    // Esc here is a no-op on purpose: the greeting is the floor of the walk, so this screen
    // cannot be escaped out of. Ctrl-C is the only way out of the CLI.
    if (pick !== 'linux' && pick !== 'windows') return A.BACK;

    const res = await S.saveSetting('platform', pick);
    if (res && res.ok === false) {
        await A.message('Could not save', [`${res.reason || 'the platform was not written'}`]);
    }

    // The setup prompt follows the platform answer ON FIRST RUN, because that is the moment
    // the answer is fresh and the user is being told how the pieces fit. It is offered again
    // from Agent access (MCP) at any time, so this is a convenience rather than the only way
    // in - and it is deliberately NOT shown on every launch, since the walk runs every launch
    // and a prompt nobody asked for becomes a keypress to dismiss.
    if (!current) await screenMcpSetupPrompt(pick);
    return 'next';
}

// ── How much of the tour? ───────────────────────────────────────────────────
//
// Asked AFTER the platform question, so the answer can be honest about what each tour
// covers on the system they just chose.
async function screenTourChoice() {
    const SK = require('./stickman.js');
    const body = [
        'You can change your mind at any point - the tour never saves anything,',
        'and it is always available again from the main menu.',
    ];
    const rows = [];
    const art = SK.frameFor('idle', 0);
    const COL = Math.max(28, Math.min(64, A.termWidth() - 26));
    const wide = A.termWidth() >= COL + 24;
    const text = [];
    for (const para of body) for (const w of A.wrapText(para, COL)) text.push(w);
    for (let i = 0; i < Math.max(text.length, wide ? art.length : 0); i++) {
        const a = wide ? (art[i] || '').padEnd(19) : '';
        const s = text[i] || '';
        rows.push(s ? `${A.padVisible('  ' + s, COL + 5)}${a}`.replace(/\s+$/, '')
                    : (a.trim() ? `${' '.repeat(COL + 5)}${a}`.replace(/\s+$/, '') : ''));
    }

    return A.menu([
        { label: 'Straight to it', hint: 'no tour - I will find my way', value: 'skip' },
        { label: 'Light tutorial', hint: 'the least it takes to get it working', value: 'basic' },
        { label: 'Full tutorial', hint: 'every screen, and how the whole thing works', value: 'full' },
    ], {
        title: 'Want a tour?',
        above: () => A.centerBlock(rows, { reserve: 8 }),
    });
}

// ── Tutorial mode ───────────────────────────────────────────────────────────
//
// Two lengths, because they are two different jobs:
//
//   basic - the least it takes to get a working setup. Add a webchat, sign in, pick a
//           harness, launch. Nothing else, so the shortest path to a result is short.
//   full  - every screen, what each setting actually does, and how the pieces fit
//           together underneath, for someone who wants to understand it rather than
//           just use it.
//
// Where there is a real screen, "Take me there" opens the actual screen instead of
// describing it. Describing a control panel is how a manual gets ignored; the point of
// having the CLI open is that it can show you the thing itself.
//
// The tour writes nothing. It is the one place the user is invited to poke at settings,
// so it must be the place that quietly changes none.
async function screenTutorial(mode = 'basic') {
    const SK = require('./stickman.js');

    const BASIC = [
        {
            pose: 'wave',
            title: 'What this is',
            lines: [
                'A webchat running in a real browser window, turned into an API.',
                'Your agent talks to that window instead of to a paid endpoint,',
                'so it uses the account you already have.',
            ],
        },
        {
            pose: 'point',
            title: '1. Add a webchat',
            lines: [
                'Webchats is where you add one. Pick a site, and a browser window',
                'opens for you to sign in to. Do that by hand, once.',
                '',
                'Each webchat gets its own browser and its own port, chosen',
                'automatically so nothing on your machine clashes.',
            ],
            goto: 'webchats',
            press: 'Click Webchats. Press Enter on Add a webchat, pick a site, sign in in the window that opens.',
        },
        {
            pose: 'idle',
            title: '2. Pick your agent',
            lines: [
                'Harness is which agentic CLI runs against it - Claude Code,',
                'opencode or Codex. One at a time.',
                '',
                'If one is not installed it is shown greyed out with the reason,',
                'instead of failing later in a confusing way.',
            ],
            goto: 'harnesses',
            press: 'Press Enter on Agentic harness, then Enter on the one you want. One only.',
        },
        {
            pose: 'point',
            title: '3. Launch',
            lines: [
                'Launch starts the webchats, connects your agent to them, and',
                'opens it in a terminal.',
                '',
                'That is the whole path. The full tour explains the rest.',
            ],
            goto: 'launch',
            press: 'Press Enter on Launch. Read the summary it prints before it starts.',
        },
    ];

    const FULL = BASIC.concat([
        {
            pose: 'think',
            title: 'How the pieces fit',
            lines: [
                'A browser per webchat, a gateway per browser, and a hub in front.',
                '',
                'The gateway is what speaks the model API. The hub is one url that',
                'forwards each request to the gateway that owns that webchat, so',
                'you point your agent at a single address and it sees all of them.',
            ],
        },
        {
            pose: 'idle',
            title: 'Models and toggles',
            lines: [
                'A webchat has options the API has no word for: DeepSeek has',
                'DeepThink and Search, ChatGPT has a thinking toggle.',
                '',
                'So every combination is published as its own model name. Switch',
                'model, and the harness flips the right switches for you.',
            ],
            goto: 'webchats',
            press: 'In Webchats, press Enter to open a webchat and look at its model names.',
        },
        {
            pose: 'think',
            title: 'Tools',
            lines: [
                'Tools decides what your agent may actually do: read files, write',
                'them, run shell commands, search the web.',
                '',
                'Each shows true or false. Switching one off removes it from what',
                'the model is even offered, so it cannot waste a turn trying.',
            ],
            goto: 'tools',
            press: 'In Tools, press Enter on a tool and watch true turn into false.',
        },
        {
            pose: 'point',
            title: 'Limits - the important part',
            lines: [
                'Every tool takes LIMITS. A limit is text matched against that',
                'tool arguments, and it is enforced one of two ways.',
                '',
                'Hard ban: refused outright, and the model is told that rewording',
                'it is not allowed. Ask: refused until YOU approve, in every mode.',
                '',
                'So you can leave shell access on but ban curl, or let files be',
                'edited but never .env.',
            ],
            goto: 'tools',
            press: 'Pick Tools, then Limits., choose a tool, then Add a limit. Try BAN, then ASK.',
        },
        {
            pose: 'think',
            title: 'Mode',
            lines: [
                'Mode is how much your agent may do without asking.',
                '',
                'A limit marked ASK overrides it. That is deliberate: yolo mode',
                'exists to skip prompts, and an ask limit is the one thing that',
                'must not be skipped.',
            ],
            goto: 'harnesses',
            press: 'Open Permission mode and read what each one lets through.',
        },
        {
            pose: 'idle',
            title: 'Config',
            lines: [
                'Every setting, grouped, each showing WHERE its value comes from.',
                '',
                'An environment variable beats the config file. A setting shown as',
                'shadowed will ignore anything you type here, which is why the CLI',
                'says so instead of pretending the edit worked.',
            ],
            goto: 'settings',
            press: 'Open Config and press Enter on any setting to see where its value comes from.',
        },
        {
            pose: 'point',
            title: 'Doctor and Logs',
            lines: [
                'Doctor checks every moving part and names the unhappy one.',
                '',
                'Logs shows what the webchats have been doing, and can build a bug',
                'report for you.',
            ],
            goto: 'doctor',
            press: 'Press Enter on Doctor. Green means that part is happy.',
        },
        {
            pose: 'idle',
            title: 'Platform and MCP',
            lines: [
                'Platform says which system your AGENT is on, not this machine. It',
                'decides the shell, how paths are written, and what is refused.',
                '',
                'Agent access (MCP) exposes all of this over MCP, so an agent can',
                'drive the harness itself - add a webchat, read a log, change a',
                'setting - instead of you clicking.',
            ],
            goto: 'agentaccess',
            press: 'Open Agent access (MCP) to see how an agent drives this harness itself.',
        },
    ]);

    const steps = mode === 'full' ? FULL : BASIC;

    // EVERY write the tour provokes is mocked while it runs. The user is sent into the
    // real screens and told to press real buttons - that is how you teach a control panel
    // - but being shown around must not leave a trail of changed settings behind, and
    // someone who is only exploring should never have to undo anything.
    //
    // The restore is in a finally so it survives every way out: finishing the tour, the
    // Exit button, Esc, or an error thrown by a screen. A demo flag left on would mean
    // the CLI silently stopped saving, which is far worse than the tour not running.
    const demoWas = S.setDemoMode(true);
    try {
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const art = SK.frameFor(s.pose, i);
        const COL = Math.max(28, Math.min(60, A.termWidth() - 26));
        const wide = A.termWidth() >= COL + 24;
        // A card is written as readable lines, but those breaks are the AUTHOR's, not the
        // screen's: wrapping them individually leaves a stranded word ("reason,") whenever
        // a hand-written line runs a little past the column. Merging consecutive lines
        // into paragraphs first lets the wrapper place every break itself.
        const paras = [];
        for (const line of s.lines) {
            const last = paras.length - 1;
            if (!line.trim()) { paras.push(''); continue; }
            if (last >= 0 && paras[last] && !/\n$/.test(paras[last])) paras[last] += ` ${line.trim()}`;
            else paras.push(line.trim());
        }
        const text = [];
        for (const para of paras) for (const w of A.wrapText(para, COL)) text.push(w);
        const rows = [];
        for (let r = 0; r < Math.max(art.length, text.length); r++) {
            const a = (art[r] || '').padEnd(19);
            const line = text[r] || '';
            rows.push(line ? `${A.padVisible('  ' + line, COL + 5)}${a}`.replace(/\s+$/, '') : (a.trim() ? `${' '.repeat(COL + 5)}${a}`.replace(/\s+$/, '') : ''));
        }

        const items = [];
        if (s.goto) items.push({ label: 'Take me there', hint: `open ${s.title}`, value: 'go' });
        items.push({ label: i + 1 < steps.length ? 'Next' : 'Finish', hint: `${i + 1} of ${steps.length}`, value: 'next' });
        // Always last and always present, so leaving is never a hunt. Esc does the same
        // thing, and both are named on screen rather than left to be discovered.
        items.push({ label: 'Exit the tour', hint: 'leave now — Esc does the same', value: 'exit' });

        const pick = await A.menu(items, {
            title: `${s.title}   (${i + 1}/${steps.length})`,
            above: () => A.centerBlock(rows.concat(s.press ? ['', A.cyan(`  ▸ ${s.press}`)] : []), { reserve: 11 }),
            footer: [
                A.cyan('Tour mode: nothing is saved.') + A.dim(' Change anything you like.'),
                A.dim('Exit the tour at any time with this button or by pressing Esc.'),
            ],
        });

        if (pick === A.BACK || pick === 'exit') return false;
        if (pick === 'go') {
            try {
                if (s.goto === 'webchats') await gatesScreens().screenGates();
                else if (s.goto === 'tools') await gatesScreens().screenTools();
                else if (s.goto === 'harnesses') await gatesScreens().screenHarnesses();
                else if (s.goto === 'launch') await screenStart();
                else if (s.goto === 'doctor') await screenDoctor();
                else if (s.goto === 'settings') await screenSettings();
                else if (s.goto === 'agentaccess') await screenAgentAccess();
            } catch (e) {
                if (e instanceof A.QuitError) throw e;
                await A.message('That screen could not open', [String(e.message || e)]);
            }
        }
    }
    return true;
    } finally {
        // Put the writer back exactly as it was, whatever happened above.
        S.setDemoMode(demoWas);
    }
}

// ── Which system is the agent on? ───────────────────────────────────────────
//
// Everything platform-shaped reads from `platform`: which shell a command runs in, how a
// path is spelled, which command patterns are refused, and which sandbox roots make
// sense. Guessing it from process.platform is wrong for the case this harness exists for
// - driving an agent on Windows from a Linux browser - so it is asked once, and after
// that it is a setting like any other.
// Has the user ever answered the platform question? The key being present in the FILE is
// the signal — a value that only comes from the schema default is not an answer.
function platformChosen() {
    try {
        const { raw } = S.loadRaw();
        return raw && raw.platform !== undefined && raw.platform !== null && raw.platform !== '';
    } catch {
        return true;   // an unreadable config is not a first run; do not block the CLI
    }
}

async function interactive() {
    A.installGuards();
    // Take the whole screen. Without this the UI is drawn INLINE into the scrollback, so
    // every redraw leaves the previous frame behind and the boxes pile up on top of each
    // other — which is what made the editor look broken. The alternate buffer is what
    // every full-screen TUI uses; `restore()` hands the terminal back on any exit path.
    A.enterFullScreen();

    // ── The opening screens are a WALK, and Esc walks back ───────────────────
    //
    // Esc used to mean "carry on with whatever is next", which is why it read as
    // moving FORWARD: on the greeting it went on to the platform question, and on the
    // tour question it went on to the menu. A back key that advances is worse than no
    // back key at all.
    //
    // Now it is a position, not a one-way run: Esc steps back one screen, and the
    // GREETING is the floor. At the greeting Esc does nothing, so the CLI cannot be
    // Escaped out of at all - Ctrl-C is the only way out, and that is deliberate.
    const OPENING = [
        async () => screenWelcome(),
        async () => {
            const pick = await screenTourChoice();
            if (pick === A.BACK) return A.BACK;
            if (pick === 'basic' || pick === 'full') await screenTutorial(pick);
            return 'next';
        },
    ];

    // The walk runs EVERY launch. It used to be skipped once the platform had been
    // answered, so `webchat` dropped straight onto the dashboard and the greeting - the
    // thing the product opens with - was never seen again. The platform row shows the
    // current choice, so a returning user is one Enter from the menu.
    let at = 0;
    while (at < OPENING.length) {
        let step;
        try { step = await OPENING[at](); }
        catch (e) { if (e instanceof A.QuitError) { A.restore(); return; } throw e; }
        at = step === A.BACK ? Math.max(0, at - 1) : at + 1;
    }

    for (;;) {
        let choice;
        try {
            choice = await screenDashboard();
        } catch (e) {
            if (e instanceof A.QuitError) break;
            throw e;
        }
          // Back on the main menu returns to the opening screens rather than quitting:
          // the walk is the floor, and only Ctrl-C leaves.
          if (choice === A.BACK || choice === 'restart') { at = 0; while (at < OPENING.length) {
              const step = await OPENING[at]();
              at = step === A.BACK ? Math.max(0, at - 1) : at + 1;
          } continue; }
          try {
              // `site` is the old single-webchat screen; kept reachable so an older
              // habit still lands somewhere sensible, but the menu advertises Webchats.
              if (choice === 'site') await screenSite();
              else if (choice === 'webchats') await gatesScreens().screenGates();
              else if (choice === 'harnesses') await gatesScreens().screenHarnesses();
              else if (choice === 'mode') await gatesScreens().screenMode();
              else if (choice === 'plan') {
                  const next = await gatesScreens().screenPlan();
                  // `return` here ENDED the CLI: the launch worked, then the terminal
                  // the user was standing in went back to a prompt. Launching is a
                  // detour, not an exit.
                  if (next === 'launch') { await cmdStart([]); continue; }
              } else if (choice === 'tools') await gatesScreens().screenTools();
              else if (choice === 'agentaccess') await screenAgentAccess();
              else if (choice === 'gates') await screenGates();
              else if (choice === 'settings') await screenSettings();
              else if (choice === 'start') await screenStart();
              else if (choice === 'logs') await screenLogs();
              else if (choice === 'doctor') await screenDoctor();
              else if (choice === 'tutorial') await screenTutorial();
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
      ${A.bold(A.cyan('webchat start'))}    bring it all up and open your agent in its own window

    Everything is reachable from ${A.bold('webchat')}’s menu: choose the site, launch and
    log in, start the harness, change any setting, read the logs, run the doctor.

    ${A.bold('The browser window')}
    The browser runs ${A.bold('headed')} by default so it keeps your login, and it no longer
    jumps onto your screen when a message is sent — nothing raises it, so minimise it
    once and it stays minimised. To move it yourself:
      ${A.bold(A.cyan('webchat window status'))}     what state it is in
      ${A.bold(A.cyan('webchat window raise'))}      bring it up (use this to sign in)
      ${A.bold(A.cyan('webchat window drop'))}       minimise it, and it stays down
      ${A.bold(A.cyan('webchat window maximize'))}   maximise it, and it stays up
    Works on Linux, macOS and Windows. Prefer no window at all? Set
    ${A.bold('Browser: headed or headless')} to ${A.bold('headless')} in ${A.bold('webchat settings')} (or BROWSER_MODE=headless).

    ${A.bold('First run')}
      1. ${A.bold('webchat')}                    open the dashboard
      2. ${A.bold('Webchats → Add a webchat')}   pick the site, then "Open the browser"
      3. sign in to that window                 (you do this, not the CLI)
      4. ${A.bold('Webchats → Connect …')}       it checks the tab and records the webchat
      5. ${A.bold('webchat start')}   harness + agent, wired up

    ${A.bold('Several webchats at once')}
      Each one gets its own browser, profile and ports, so Gemini and ChatGPT can
      both be connected and used as separate models (${A.cyan('webchat/gemini')},
      ${A.cyan('webchat/chatgpt')}) from inside your agent.

    ${A.bold('Options')}
      webchat --help          this text
  `;
// `webchat window raise|drop|maximize|status` — the cross-platform window control.
//
// It shells out to window.js instead of re-implementing the CDP calls here, so the
// CLI and the standalone script can never drift apart about where the window is.
// Why it exists at all: the browser is HEADED on purpose (it keeps the login), so
// it has a real window. Nothing raises it any more — new pages are created with
// background:true — so minimise once and it stays down. This command is for when
// you deliberately want it moved (chiefly: raise it, sign in, drop it).
function cmdWindow(args) {
    const { spawnSync } = require('child_process');
    const script = path.join(__dirname, '..', 'src', 'browser', 'window.js');
    const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
    if (r.error) {
        process.stderr.write(`webchat window: ${r.error.message}\n`);
        return 1;
    }
    return r.status === null ? 1 : r.status;
}

// Run a screen the way the dashboard runs: full-screen, guards installed, and the
// terminal restored on the way out whatever happens. `main()` covers five entry points
// that each duplicated this pairing by hand, which is how one of them ends up missing
// restore() and leaves the user in the alternate buffer with no output.
async function withScreen(fn) {
    A.installGuards();
    A.enterFullScreen();
    try {
        await fn();
        return 0;
    } catch (e) {
        if (!(e instanceof A.QuitError)) {
            A.restore();
            throw e;
        }
        return 0;
    } finally {
        A.restore();
    }
}

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

    // `start` is the name; `connect` is kept as an alias so an existing habit, script or
    // README line does not break.
    if ((cmd === 'start' || cmd === 'connect') && argv[1] !== '--help') return cmdStart(argv.slice(1));

    if (cmd === 'start') return withScreen(() => screenStart());
    if (cmd === 'doctor') return withScreen(() => screenDoctor());
    if (cmd === 'logs') return withScreen(() => screenLogs());
    if (cmd === 'settings') return withScreen(() => screenSettings());
    if (cmd === 'setup') return withScreen(() => screenSite());
    if (cmd === 'window') return cmdWindow(argv.slice(1));

    await interactive();
    return 0;
}

module.exports = {
    main, interactive, platformChosen, screenWelcome, screenTourChoice, screenTutorial,
    connectionBadge,
    currentPlatform,
    // These were exported by a SECOND module.exports earlier in the file, which the
    // assignment below silently overwrote — so anything importing them got undefined.
    // One export object, at the end, is the only safe shape.
    screenDashboard, screenSite, screenSettings, screenGates, screenStart,
    screenLogs, screenDoctor, cmdStatus, cmdStart,
};
