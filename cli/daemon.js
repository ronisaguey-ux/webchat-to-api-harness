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
function gatewayRunning() {
    const pid = readPid('gateway');
    if (!isAlive(pid)) { if (pid) clearPid('gateway'); return null; }
    return pid;
}

function startGateway(opts = {}) {
    const existing = gatewayRunning();
    if (existing) return { started: false, pid: existing, reason: 'already running' };

    ensureStateDir();
    const out = fs.openSync(logFile('gateway'), 'a');
    fs.writeSync(out, `\n─── gateway start ${new Date().toISOString()} ───\n`);
    const err = fs.openSync(logFile('gateway.err'), 'a');

    const child = spawn(process.execPath, ['server.js'], {
        cwd: REPO,
        detached: true,
        stdio: ['ignore', out, err],
        // The config CLI is not the harness, so pass the environment through
        // unchanged: server.js loads .env itself and must see the same config.
        env: { ...process.env, ...(opts.env || {}) },
    });
    child.unref();
    writePid('gateway', child.pid);
    fs.closeSync(out);
    fs.closeSync(err);
    return { started: true, pid: child.pid };
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
function realDisplay() {
    if (process.env.WEBCHAT_DISPLAY) return process.env.WEBCHAT_DISPLAY;
    const virtual = /^:9[0-9]$/;
    const env = process.env.DISPLAY;
    if (env && !virtual.test(env)) return env;
    if (fs.existsSync('/tmp/.X11-unix/X0')) return ':0';
    try {
        const socks = fs.readdirSync('/tmp/.X11-unix').filter((f) => /^X\d+$/.test(f));
        const real = socks.map((f) => ':' + f.slice(1)).find((d) => !virtual.test(d));
        if (real) return real;
    } catch { /* no X at all */ }
    return env || '';
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
    const port = opts.port || 9225;
    const bin = opts.executable || chromePath();
    if (!bin) return { started: false, error: 'no Chrome or Chromium found — set CHROME_PATH' };

    // A debugging port is only accepted with a NON-default profile directory.
    const profile = profileDir();
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
    const env = { ...process.env };
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

module.exports = {
    REPO, stateDir, ensureStateDir, profileDir,
    pidFile, logFile,
    readPid, isAlive, writePid, clearPid,
    httpGet, httpPost, probeGateway,
    gatewayRunning, startGateway, stopProcess,
    chromePath, cdpAlive, cdpTargets, browserRunning, launchBrowser,
    tailLines,
    copyToClipboard, restoreForExec,
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
