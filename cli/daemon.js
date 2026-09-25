'use strict';
//
// daemon.js — process lifecycle for the browser and the gateway.
//
// The user's flow needs `webchat start` to work from a DIFFERENT terminal than
// the one used to configure things, so the config CLI cannot be the parent of
// the browser and gateway: it has to hand them to init and exit cleanly. That is
// what `detached: true` + `unref()` below do, with a pidfile as the handle.
//
// Two hard-won details are encoded here:
//
//   * `/health` answers **HTTP 503 while the browser is not attached yet**, and
//     that still means "the gateway is up and will attach on the first request".
//     Treating the status code as truth makes a healthy gateway look dead, so
//     `probeGateway` reads the BODY and reports `ok` on a parseable body.
//
//   * Chrome refuses `--remote-debugging-port` when it is pointed at the DEFAULT
//     profile directory ("DevTools remote debugging requires a non-default data
//     directory"). The profile is therefore always explicit, which is also what
//     makes the login survive a restart.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');

function stateDir() {
    return process.env.WEBCHAT_STATE_DIR
        ? path.resolve(process.env.WEBCHAT_STATE_DIR)
        : path.join(REPO, '.webchat');
}
function ensureStateDir() {
    const d = stateDir();
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
}
const pidFile = (name) => path.join(stateDir(), `${name}.pid`);
const logFile = (name) => path.join(stateDir(), `${name}.log`);

// ── Per-gate gateways ───────────────────────────────────────────────────────
//
// One gateway serves one browser. With several webchats connected at once there has
// to be one gateway PER gate, on that gate's port — otherwise every model would send
// through whichever browser the single gateway attached to.
//
// The primary gate keeps the historic unsuffixed names ('gateway.pid', 'gateway.log')
// so an already-running gateway is still found, not duplicated onto its own port.
//
// Read lazily from PORT rather than hardcoded: server.js binds the CONFIGURED port,
// so a box whose config says 8080 would otherwise look for 'gateway-8080' and miss
// the instance it already has.
const DEFAULT_GATEWAY_PORT = 8081;
function defaultGatewayPort() {
    const fromEnv = Number(process.env.PORT || 0);
    return fromEnv > 0 ? fromEnv : DEFAULT_GATEWAY_PORT;
}
function gatewayKey(port) {
    const p = Number(port) || defaultGatewayPort();
    return p === defaultGatewayPort() ? 'gateway' : `gateway-${p}`;
}
const profileDir = () => process.env.CHROME_PROFILE || path.join(stateDir(), 'chrome-profile');

// ── pidfiles ───────────────────────────────────────────────────────────────
function readPid(name) {
    const f = pidFile(name);
    if (!fs.existsSync(f)) return null;
    const n = Number(fs.readFileSync(f, 'utf-8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

function isAlive(pid) {
    if (!pid) return false;
    try {
        // Signal 0 does not deliver anything; it only asks "may I signal this?".
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM means the process exists but belongs to someone else.
        return e.code === 'EPERM';
    }
}

function writePid(name, pid) {
    ensureStateDir();
    fs.writeFileSync(pidFile(name), `${pid}\n`, { mode: 0o600 });
}

function clearPid(name) {
    const f = pidFile(name);
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ── HTTP ───────────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
            res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
}

async function httpPost(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
            timeout: timeoutMs,
        }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.end('{}');
    });
}

// Reads the BODY, and treats a 503 as up. See the header comment.
async function probeGateway(host, port) {
    const res = await httpGet(`http://${host}:${port}/health`);
    if (!res.ok) return { up: false, error: res.error };
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { /* non-JSON body still proves a listener */ }
    return {
        up: true,
        httpStatus: res.status,
        body: parsed,
        // The gateway is listening. `attached` is the browser half.
        attached: Boolean(parsed && (parsed.browserAlive || parsed.ok)),
        wedged: Boolean(parsed && parsed.wedged),
    };
}

// ── the gateway (server.js) ────────────────────────────────────────────────
function gatewayRunning(port) {
    const key = gatewayKey(port);
    const pid = readPid(key);
    if (!isAlive(pid)) { if (pid) clearPid(key); return null; }
    return pid;
}

/**
 * Start a gateway for one gate.
 *
 * `port` is the port it must bind, `cdpPort` is the browser it must attach to, and
 * both are passed as environment rather than written to the config file: the config
 * is shared by every gate, so writing them would make the gates fight over one file
 * and the last writer would silently win for everybody.
 */
function startGateway(opts = {}) {
    const port = Number(opts.port) || defaultGatewayPort();
    const key = gatewayKey(port);
    const existing = gatewayRunning(port);
    if (existing) return { started: false, pid: existing, reason: 'already running' };

    ensureStateDir();
    const out = fs.openSync(logFile(key), 'a');
    fs.writeSync(out, `\n─── gateway start ${new Date().toISOString()} (port ${port}) ───\n`);
    const err = fs.openSync(logFile(`${key}.err`), 'a');

    const child = spawn(process.execPath, ['server.js'], {
        cwd: REPO,
        detached: true,
        stdio: ['ignore', out, err],
        // The config CLI is not the harness, so pass the environment through
        // unchanged: server.js loads .env itself and must see the same config.
        env: {
            ...process.env,
            ...(opts.env || {}),
            PORT: String(port),
            ...(opts.cdpPort ? { CDP_PORT: String(opts.cdpPort) } : {}),
            // Each webchat needs its own site quirks. Without this every gateway ran
            // the generic mode, so the Gemini gateway used the wrong composer and
            // answer selectors and connected to the page but never read it.
            ...(opts.mode ? { WEBCHAT_MODE: String(opts.mode) } : {}),
            // The model id THIS gateway answers to: <site>-webchat, the same name the CLI
            // hands the harness. Without it the gateway keeps the old default and a
            // harness sending the new name is proxied to the real upstream - a 401 that
            // reads like an auth bug.
            ...((opts.modelName || opts.mode) ? { MODEL_NAME: String(opts.modelName || `${opts.mode}-webchat`) } : {}),
            // The gateway drives a HEADED browser, so it needs the display too. Without
            // this a gateway started from a shell with no DISPLAY fails every send
            // with "Missing X server to start the headful browser".
            ...displayEnv(),
            // Scope the send mutex to THIS gateway's browser. Without it server.js
            // falls back to the host name, so every gateway on deepseek.com - including
            // another stack's - shares one lock and the loser waits out the full lock
            // timeout on a send its own browser was ready for. Observed live: the
            // harness gateway failed every send with "another chat is mid-generation"
            // while its chrome sat idle. Two gateways on the SAME profile must still
            // contend (one account cannot send twice at once), and they do - the lock
            // is keyed on the profile, not the process.
            ...(opts.profile ? { WEBCHAT_PROFILE: String(opts.profile) } : {}),
        },
    });
    child.unref();
    writePid(key, child.pid);
    fs.closeSync(out);
    fs.closeSync(err);
    return { started: true, pid: child.pid, port };
}

/** Stop the gateway for one port, and only that one. */
// The hub is one process serving one url, so it has a single fixed key.
const HUB_KEY = 'hub';

function hubRunning() {
    const pid = readPid(HUB_KEY);
    if (!pid) return 0;
    try { process.kill(pid, 0); return pid; } catch { return 0; }
}

function startHub(opts = {}) {
    const existing = hubRunning();
    if (existing) return { started: false, reason: 'already running', pid: existing };
    const port = Number(opts.port);
    if (!port) return { started: false, reason: 'no port' };
    ensureStateDir();
    const out = fs.openSync(path.join(stateDir(), `hub-${port}.log`), 'a');
    const child = spawn(process.execPath, [path.join(__dirname, 'hub-server.js')], {
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, HUB_PORT: String(port) },
    });
    child.unref();
    writePid(HUB_KEY, child.pid);
    return { started: true, pid: child.pid, port };
}

function stopHub() {
    const pid = hubRunning();
    if (!pid) return { stopped: false, reason: 'not running' };
    try { process.kill(pid, 'SIGTERM'); } catch (e) { return { stopped: false, reason: e.message }; }
    clearPid(HUB_KEY);
    return { stopped: true, pid };
}

function stopGateway(port) {
    const key = gatewayKey(port);
    const pid = gatewayRunning(port);
    if (!pid) return { stopped: false, reason: 'not running' };
    try {
        process.kill(pid, 'SIGTERM');
    } catch (e) {
        return { stopped: false, reason: e.message };
    }
    clearPid(key);
    return { stopped: true, pid };
}

/** Every gateway this box knows about, running or not. */
function listGateways() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(stateDir()); } catch { return out; }
    for (const f of files) {
        const m = /^gateway(-(\d+))?\.pid$/.exec(f);
        if (!m) continue;
        const port = m[2] ? Number(m[2]) : defaultGatewayPort();
        const pid = readPid(gatewayKey(port));
        out.push({ port, pid, alive: !!isAlive(pid) });
    }
    return out.sort((a, b) => a.port - b.port);
}

function stopProcess(name, { graceMs = 4000 } = {}) {
    const pid = readPid(name);
    if (!isAlive(pid)) { if (pid) clearPid(name); return { stopped: false, reason: 'not running' }; }
    try { process.kill(pid, 'SIGTERM'); } catch (e) { clearPid(name); return { stopped: false, reason: e.message }; }

    // Give it a moment to exit cleanly before insisting.
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
        if (!isAlive(pid)) { clearPid(name); return { stopped: true, pid, sigterm: true }; }
        // Busy-wait in small slices; this is a CLI, not an event loop hot path.
        try { execFileSync('sleep', ['0.1'], { stdio: 'ignore' }); } catch { /* sleep missing */ }
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    clearPid(name);
    return { stopped: true, pid, sigterm: false };
}

// ── the browser ────────────────────────────────────────────────────────────
// Which X display should a HUMAN see a window on?
//
// The launch button exists so the user can sign in, which only works if the window
// lands on the display they are looking at. Preference order:
//   1. an explicitly exported DISPLAY that is NOT one of our own virtual ones —
//      WEBCHAT_DISPLAY overrides this;
//   2. :0, the usual desktop display on this box;
//   3. the first non-virtual X socket in /tmp/.X11-unix.
//
// Virtual displays (:99 and up) are deliberately skipped: the gateway uses them so
// the browser is invisible, and sending a login window there would hide the very
// thing the user needs to interact with.
function displayWorks(d) {
    // Whether a display actually answers. A socket in /tmp/.X11-unix is NOT proof: on
    // this box X0 exists while `xdpyinfo -display :0` fails, so picking it sent the login
    // window to a display nobody can see. The candidate has to be probed.
    if (!d || !fs.existsSync('/tmp/.X11-unix/X' + d.replace(':', ''))) return false;
    try {
        // The auth file must be passed too. The real desktop display (:2 here) needs it
        // and rejects an unauthenticated probe, while our own Xvfb was started with -ac
        // and accepts anything - so without this the virtual display looks like the
        // better choice and the login window lands somewhere nobody can see it.
        const xa = xauthority();
        execFileSync('xdpyinfo', ['-display', d], {
            stdio: 'ignore',
            timeout: 4000,
            env: xa ? { ...process.env, XAUTHORITY: xa } : process.env,
        });
        return true;
    } catch { return false; }
}

function isVirtualDisplay(d) {
    // A display served by our own Xvfb is fine for the gateway and useless for a login
    // window - the user cannot see it. Read the running X servers rather than guessing
    // from the display number (the virtual one here is :1, not the usual :99).
    try {
        for (const pid of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(pid)) continue;
            let cmd;
            try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
            if (!cmd.includes('Xvfb')) continue;
            if (cmd.split('\0').includes(d)) return true;
        }
    } catch { /* /proc unreadable */ }
    return /^:9[0-9]$/.test(d);
}

function realDisplay() {
    // The launch button exists so the user can sign in, which only works if the window
    // lands on the display they are looking at. Preference order:
    //   1. WEBCHAT_DISPLAY if it answers;
    //   2. a display the caller exported, if it answers and is not our own virtual one;
    //   3. any display that answers, preferring a real desktop over Xvfb.
    if (process.env.WEBCHAT_DISPLAY && displayWorks(process.env.WEBCHAT_DISPLAY)) {
        return process.env.WEBCHAT_DISPLAY;
    }
    const env = process.env.DISPLAY;
    if (env && displayWorks(env) && !isVirtualDisplay(env)) return env;
    let sockets = [];
    try {
        sockets = fs.readdirSync('/tmp/.X11-unix')
            .filter((f) => /^X\d+$/.test(f))
            .map((f) => ':' + f.slice(1));
    } catch { /* no X at all */ }
    const live = sockets.filter(displayWorks);
    const real = live.filter((d) => !isVirtualDisplay(d));
    if (real.length) return real[0];
    if (live.length) return live[0];
    return '';
}

// The gateway runs the browser, so it needs the same display the launch button uses.
// Chrome without XAUTHORITY dies with "Missing X server" even when DISPLAY is right,
// and a gateway inheriting an empty DISPLAY fails the moment it has to open a tab
// itself. Discovering both here means the user never exports anything.
function xauthority() {
    if (process.env.XAUTHORITY && fs.existsSync(process.env.XAUTHORITY)) return process.env.XAUTHORITY;
    const candidates = [];
    try {
        for (const d of fs.readdirSync('/run/user')) {
            const dir = `/run/user/${d}`;
            for (const f of fs.readdirSync(dir)) {
                if (f.startsWith('xauth')) candidates.push(`${dir}/${f}`);
            }
        }
    } catch { /* no runtime dir */ }
    if (process.env.HOME) candidates.push(`${process.env.HOME}/.Xauthority`);
    return candidates.find((q) => { try { return fs.statSync(q).size > 0; } catch { return false; } }) || null;
}

function displayEnv() {
    const out = {};
    const d = realDisplay();
    if (d) out.DISPLAY = d;
    const x = xauthority();
    if (x) out.XAUTHORITY = x;
    return out;
}

function chromePath() {
    // Puppeteer ships a known-good Chromium; prefer it over guessing at system
    // names, but fall back to the system browser if puppeteer is unavailable.
    try {
        const p = require('puppeteer').executablePath();
        if (p && fs.existsSync(p)) return p;
    } catch { /* puppeteer not installed — fine, try the system */ }
    for (const candidate of [
        'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]) {
        if (candidate.startsWith('/')) { if (fs.existsSync(candidate)) return candidate; continue; }
        try {
            const found = execFileSync('which', [candidate], { encoding: 'utf-8' }).trim();
            if (found) return found;
        } catch { /* not on PATH */ }
    }
    return null;
}

async function cdpAlive(port) {
    const res = await httpGet(`http://127.0.0.1:${port}/json/version`, 1500);
    if (!res.ok) return { up: false, error: res.error };
    try { return { up: true, info: JSON.parse(res.body) }; } catch { return { up: true, info: null }; }
}

// What tabs the browser has, so the CLI can name the one it found.
async function cdpTargets(port) {
    const res = await httpGet(`http://127.0.0.1:${port}/json/list`, 2500);
    if (!res.ok) return { ok: false, error: res.error, pages: [] };
    try {
        const all = JSON.parse(res.body);
        return { ok: true, pages: all.filter((t) => t.type === 'page') };
    } catch (e) {
        return { ok: false, error: e.message, pages: [] };
    }
}

function browserRunning() {
    const pid = readPid('browser');
    if (!isAlive(pid)) { if (pid) clearPid('browser'); return null; }
    return pid;
}

function launchBrowser(opts = {}) {
    // Honour the caller's port and profile. Hardcoding 9225/`profileDir()` meant every
    // gate opened the SAME browser: the second gate's chrome never bound its own port,
    // and `webchat connect` could only ever see one webchat.
    const port = Number(opts.cdpPort || opts.port) || 9225;
    const bin = opts.executable || chromePath();
    if (!bin) return { started: false, error: 'no Chrome or Chromium found — set CHROME_PATH' };

    // A debugging port is only accepted with a NON-default profile directory.
    const profile = opts.profile || profileDir();
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        ...(opts.args || []),
    ];
    if (opts.headless) args.push('--headless=new');
    if (opts.url) args.push(opts.url);

    // ── DISPLAY: launch where a HUMAN can see it ─────────────────────────────
    // The point of this button is that the user signs in themselves, so the window
    // must appear on the display they are actually looking at. Inheriting
    // process.env is wrong in two ways:
    //   * if the caller exported a different DISPLAY (a virtual one, as the gateway
    //     uses), the login window is invisible and the user cannot sign in;
    //   * if DISPLAY is unset entirely, Chrome fails with no useful message.
    // A real desktop display is preferred explicitly, and `headed: false` lets the
    // gateway opt into a virtual display when the window must NOT be seen.
    const env = { ...process.env, ...displayEnv() };
    if (opts.headless) {
        // Nothing to show: leave the display alone.
    } else if (opts.display) {
        env.DISPLAY = opts.display;
    } else {
        env.DISPLAY = realDisplay();
    }
    if (!env.DISPLAY) {
        return {
            started: false,
            error: 'no display available (DISPLAY is unset and no X socket was found) — '
                 + 'launch from a desktop session, or install Xvfb for a virtual one',
        };
    }

    ensureStateDir();
    const child = spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
        env,
    });
    child.unref();
    writePid('browser', child.pid);
    return { started: true, pid: child.pid, executable: bin, profile, port, display: env.DISPLAY };
}

// ── logs ───────────────────────────────────────────────────────────────────
// Put text on the clipboard.
//
// Used by the problem-report screen, where "copy this" has to actually copy — a
// screen that prints a block and tells the user to select it is not a copyable report.
//
// Tries the tools that exist on this box (xclip, xsel, wl-copy for Wayland) and
// reports failure rather than pretending: the caller offers "save to a file" as the
// fallback when this returns { ok: false }.
function onPath(bin) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        try {
            fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
            return true;
        } catch { /* keep looking */ }
    }
    return false;
}

function copyToClipboard(text) {
    const candidates = [
        ['xclip', ['-selection', 'clipboard']],
        ['xsel', ['--clipboard', '--input']],
        ['wl-copy', []],
    ];
    for (const [bin, args] of candidates) {
        if (!onPath(bin)) continue;
        try {
            // These tools DO NOT EXIT — they fork and hold the X selection so a paste
            // has something to read. Waiting for them to finish therefore blocks until
            // the timeout and then reports failure over a copy that actually worked
            // (measured: the clipboard held the text while this returned ok:false).
            //
            // So: write the text, give it a moment, and treat "still running" as the
            // expected outcome rather than an error. Only a hard spawn failure or an
            // immediate non-zero exit counts as a real failure.
            const child = spawn(bin, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
            let exitCode = null;
            child.on('exit', (c) => { exitCode = c; });
            child.stdin.end(String(text));
            child.unref();
            // Wait just long enough to catch "xclip: command not found"-style
            // failures, which put nothing on the clipboard and exit immediately.
            const deadline = Date.now() + 150;
            while (Date.now() < deadline && exitCode === null) {
                try { execFileSync('sleep', ['0.02'], { stdio: 'ignore' }); } catch { /* no sleep */ }
            }
            if (exitCode !== null && exitCode !== 0) continue;
            return { ok: true, via: bin };
        } catch { /* try the next one */ }
    }
    return { ok: false, reason: 'no clipboard tool found (tried xclip, xsel, wl-copy)' };
}

function tailLines(file, n = 60) {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - n - 1));
}

// ── the "which webchat is connected" marker ─────────────────────────────────
// Written by the CLI's Connect step and read by `webchat connect`, which runs in a
// SECOND terminal. It is the handoff between the two: without it the second command
// has no idea which webchat and which browser the user just set up.
function connectFile() { return path.join(stateDir(), 'connected.json'); }

function readConnection() {
    try {
        const d = JSON.parse(fs.readFileSync(connectFile(), 'utf-8'));
        return d && typeof d === 'object' ? d : null;
    } catch { return null; }
}

function writeConnection(info) {
    ensureStateDir();
    fs.writeFileSync(connectFile(), JSON.stringify(info, null, 2), { mode: 0o600 });
    return info;
}

function clearConnection() {
    try { fs.unlinkSync(connectFile()); } catch { /* already gone */ }
}

// ── launch a program in its OWN terminal window ─────────────────────────────
//
// The agent is an interactive TUI. Handing it this terminal replaces the CLI, so the
// user loses the thing they were just using; `webchat start` gives it its own window
// instead and stays where it is. Falls back to a detached process with a log when no
// terminal emulator is installed - never to taking over the caller's TTY.
const TERMINALS = [
    { bin: 'konsole', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
    { bin: 'x-terminal-emulator', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
    { bin: 'gnome-terminal', args: (cmd) => ['--', 'bash', '-lc', cmd] },
    { bin: 'xfce4-terminal', args: (cmd) => ['-e', `bash -lc ${JSON.stringify(cmd)}`] },
    { bin: 'xterm', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
];

function whichTerminal() {
    const { spawnSync } = require('child_process');
    for (const t of TERMINALS) {
        const r = spawnSync('which', [t.bin], { encoding: 'utf-8' });
        if (r.status === 0 && String(r.stdout).trim()) return t;
    }
    return null;
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function launchInTerminal({ bin, argv = [], cwd, env = {} }) {
    const { spawn } = require('child_process');
    const cmd = `cd ${shq(cwd)} && exec ${[bin, ...argv].map(shq).join(' ')}`;
    const full = { ...process.env, ...env };
    const term = whichTerminal();
    try {
        if (term) {
            const child = spawn(term.bin, term.args(cmd), {
                detached: true, stdio: 'ignore', env: { ...full, ...displayEnv() },
            });
            child.unref();
            return { ok: true, how: 'window', terminal: term.bin, pid: child.pid };
        }
        // No terminal emulator: run it detached and leave a log, so this TTY is untouched.
        ensureStateDir();
        const out = fs.openSync(logFile('agent'), 'a');
        fs.writeSync(out, `\n─── agent start ${new Date().toISOString()} ───\n`);
        const child = spawn('bash', ['-lc', cmd], { detached: true, stdio: ['ignore', out, out], env: full });
        child.unref();
        return { ok: true, how: 'detached', log: logFile('agent'), pid: child.pid };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = {
    REPO, stateDir, ensureStateDir, profileDir,
    pidFile, logFile,
    readPid, isAlive, writePid, clearPid,
    httpGet, httpPost, probeGateway,
    gatewayRunning, startGateway, stopGateway, displayEnv,
    startHub, stopHub, hubRunning, realDisplay, isVirtualDisplay, displayWorks, listGateways, gatewayKey, defaultGatewayPort, stopProcess,
    chromePath, cdpAlive, cdpTargets, browserRunning, launchBrowser,
    tailLines,
    copyToClipboard, restoreForExec,
    launchInTerminal, whichTerminal,
    realDisplay, connectFile, readConnection, writeConnection, clearConnection,
};

// Hand the terminal back to cooked mode before spawning something that owns the
// TTY (the agent launcher). The TUI runs raw-mode and with the cursor hidden, so
// exec'ing without this leaves the child drawing into a raw terminal.
function restoreForExec() {
    try {
        if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
        process.stdout.write('\u001b[?25h');
    } catch { /* not a TTY */ }
}
