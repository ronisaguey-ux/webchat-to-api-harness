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

let SHOW_ADVANCED = false;

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
async function screenDashboard() {
    const st = state();
    const rows = rowsOf(st);
    const get = (p) => rows.find((r) => r.setting.path === p);
    const shadowed = rows.filter((r) => r.shadowedBy);

    const host = get('server.host').value || '127.0.0.1';
    const port = get('server.port').value || 8080;
    const cdpPort = Number(process.env.CDP_PORT || 9225);
    const gw = await D.probeGateway(host, port);
    const cdp = await D.cdpAlive(cdpPort);

    const body = [
        `${A.dim('config')}   ${shortHome(st.file)}`,
        `${A.dim('webchat')}  ${A.bold(get('webchat.mode').value || '(unset)')}`,
        `${A.dim('gateway')}  ${gw.up
            ? (gw.attached ? A.green('up · browser attached') : A.yellow('up · waiting for the browser'))
            : A.gray('stopped')}`,
        `${A.dim('browser')}  ${cdp.up ? A.green(`running on CDP :${cdpPort}`) : A.gray(`not running on :${cdpPort}`)}`,
        `${A.dim('bash')}     ${get('features.bashAllowed').value ? A.red('ENABLED') : A.green('disabled')}`,
        `${A.dim('sandbox')}  ${(get('network.sandboxRoots').value || []).length} root(s)`,
    ];
    if (shadowed.length) {
        body.push('');
        body.push(A.yellow(`⚠ ${shadowed.length} setting(s) come from an environment variable,`));
        body.push(A.gray('  which overrides the config file.'));
    }
    if (st.error) body.push('', A.red(`config parse error: ${st.error.message}`));

    A.clear();
    header([shortHome(st.file)]);
    for (const l of A.boxLines('Status', body)) A.line(l);
    A.newline();

    return A.menu([
        { label: 'Webchat & browser', hint: 'pick the site, launch it, log in, connect', value: 'site' },
        { label: 'Gates & sandbox', hint: 'what the model may touch', value: 'gates' },
        { label: 'All settings', hint: 'every setting, grouped, with its resolving source', value: 'settings' },
        { label: 'Start the harness', hint: 'bring the gateway up, then your IDE', value: 'start' },
        { label: 'Logs', hint: 'gateway output', value: 'logs' },
        { label: 'Doctor', hint: 'check everything and report', value: 'doctor' },
        { label: 'Quit', value: 'quit' },
    ], { title: 'What do you want to do?' });
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
        const body = [
            `${A.dim('selected')}  ${A.bold(modeRow.value || '(unset)')}`,
            `${A.dim('browser')}   ${cdp.up ? A.green(`running on CDP :${cdpPort}`) : A.gray('not running')}`,
            `${A.dim('profile')}   ${shortHome(D.profileDir())}`,
        ];
        if (modeRow.shadowedBy) {
            body.push('');
            body.push(A.yellow(`⚠ ${modeRow.shadowedBy} in ${shortHome(modeRow.shadowedWhere)} overrides the file`));
        }
        for (const l of A.boxLines('Connection', body)) A.line(l);
        A.newline();

        const choice = await A.menu([
            { label: 'Choose webchat', hint: `${S.listModes(st.raw).length} configured`, value: 'pick' },
            { label: 'Launch a browser to log in', hint: 'opens a window you sign into', value: 'launch' },
            { label: 'Attach to a browser I already have open', hint: 'connect to an existing CDP port', value: 'attach' },
            { label: 'Check connection', hint: 'verify the tab is logged in and ready', value: 'check' },
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
            'Use "Check connection" to verify the tab.',
        ]);
        return;
    }
    const go = await A.confirm(
        `Launch a browser window and open ${url || 'the webchat'}?`,
        { footer: 'You log in yourself. The profile lives under .webchat/ so the login survives restarts.' },
    );
    if (go !== true) return;

    const port = Number(process.env.CDP_PORT || 9225);
    const res = D.launchBrowser({ port, url });
    if (!res.started) {
        await A.message('Could not launch', [A.red(res.error || 'unknown error')]);
        return;
    }
    await A.message('Browser launched', [
        A.dim(res.executable),
        '',
        A.bold('Sign in to the webchat in that window.'),
        'When the chat page is loaded and signed in, come back and use',
        `${A.bold('Check connection')} to confirm.`,
        '',
        A.dim(`profile ${shortHome(res.profile)}`),
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

    await A.message('Connected', [
        A.green('This webchat is marked connected.'),
        '',
        A.bold('Next:'),
        '  1. Leave that browser window alone — the harness drives it.',
        '  2. Open a NEW terminal.',
        `  3. Run ${A.bold(A.cyan('webchat start'))} to bring up the harness and your IDE.`,
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
            { label: 'Back', value: 'back' },
        ], { title: 'Which log?' });
        if (which === A.BACK || which === 'back') return;

        const lines = D.tailLines(D.logFile(which), 40);
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
        A.line(A.gray('  r refresh · any other key returns'));
        const key = await A.readKey();
        if (key.name !== 'char' || key.char !== 'r') return;
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

function cmdStart() {
    // Thin client: bring the pieces up and exit, so it is safe to run from any
    // terminal. The heavy lifting is the same code the TUI uses.
    return screenStart();
}

module.exports = {
    screenDashboard, screenSite, screenSettings, screenGates, screenStart,
    screenLogs, screenDoctor, cmdStatus, cmdStart,
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
            if (choice === 'site') await screenSite();
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
  ${A.bold('webchat')} — configure and run the webchat-to-API harness

  ${A.bold('Usage')}
    webchat                 open the interactive configurator
    webchat setup           same, but straight into Webchat & browser
    webchat status          one-line state of the gateway and browser
    webchat start           bring the gateway up, start, then offer your IDE
    webchat logs [gateway]  tail a log
    webchat doctor          check the environment and report
    webchat settings        open the settings screens
    webchat --help          this text

  ${A.bold('First run')}
    1. webchat              pick your webchat, launch the browser, log in
    2. Check connection     the CLI verifies the tab and you confirm
    3. webchat start        new terminal — brings up the harness and your IDE
`;

async function main(argv) {
    const cmd = argv[0];
    A.installGuards();

    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
        A.clear();
        A.line(USAGE);
        return 0;
    }
    if (cmd === 'status') return cmdStatus();

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

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => { A.restore(); process.exit(code || 0); })
        .catch((e) => {
            A.restore();
            A.line(`  ${A.red('webchat: ' + (e && e.message ? e.message : String(e)))}`);
            process.exit(1);
        });
}

module.exports = { main, interactive };
