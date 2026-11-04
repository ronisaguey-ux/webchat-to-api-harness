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
const net = require('net');
const { spawn, execFileSync } = require('child_process');

// ── ports ──────────────────────────────────────────────────────────────────
//
// These live here, not in gates.js, because gates.js already requires this module — the
// other direction would be a cycle, and a lazy require to dodge one is the kind of thing
// that works until someone imports in a different order. gates.js re-exports them so the
// rest of the CLI keeps calling G.freePortPair().

// Ask the OS for a port nobody holds. Binding to 0 and reading back the assigned port is
// the only reliable test: a "is this number taken" check races anything that binds between
// the check and the use.
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// Is THIS specific port bindable on loopback right now? `freePort()` answers "give me one
// nobody holds"; this answers "is this one taken?", which is what a caller needs before
// binding to a number it already has. The bind IS the test.
function isPortFree(port) {
    return new Promise((resolve) => {
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) return resolve(false);
        const srv = net.createServer();
        srv.unref();
        srv.once('error', () => resolve(false));
        srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
}

// Pick two DIFFERENT values from `next()`, retrying when they collide.
//
// The generator is a parameter so the retry is testable without waiting for a 1-in-200 OS
// coincidence: a stub that returns a collision first proves the loop runs, which a
// probabilistic test on real ports cannot do reliably.
async function distinctPair(next = freePort) {
    const a = await next();
    let b = await next();
    for (let i = 0; i < 10 && b === a; i++) b = await next();
    return { a, b };
}

// A CDP port and a gateway port that nothing is listening on right now. The two halves
// must DIFFER: as two sequential freePort() calls the OS could hand the second the port the
// first had just released — measured at 1 in 200 pairs, and a gateway sharing a number with
// its own browser's debug port is a start that cannot work.
async function freePortPair() {
    const { a, b } = await distinctPair(freePort);
    return { cdpPort: a, gatewayPort: b };
}

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

/**
 * Has this process actually EXITED, as opposed to merely not answering signals?
 *
 * isAlive() is wrong for this question in one specific way that matters: a ZOMBIE still
 * accepts signal 0 until its parent reaps it, so a process that answered SIGTERM and died is
 * reported alive. Measured while fixing stopGateway — a cooperative gateway read as
 * "did not exit" because its parent had not waited on it yet.
 *
 * A stopped process (T/t state) is NOT dead: it still holds its memory and its ports, which is
 * exactly what the caller is trying to release.
 */
function processExited(pid) {
    if (!pid) return true;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // Field 3 is the state. The comm field can contain spaces and parens, so parse from
        // the LAST ')' rather than splitting on whitespace.
        const after = stat.slice(stat.lastIndexOf(')') + 2);
        const state = after.charAt(0);
        if (state === 'Z' || state === 'X') return true;   // zombie / dead
        return false;
    } catch {
        // No /proc entry: gone, or never ours. Either way it is not holding anything.
        return true;
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

// Is this pid actually OUR gateway, or just a live process wearing the number?
//
// `isAlive(pid)` answers "may I signal this pid?", which stays true after our gateway dies
// and the OS reuses the number for something unrelated. Trusting it alone makes the CLI
// report a running gateway that is not there — the same lie, in the same file, as
// `connected` outliving its browser.
//
// The cmdline is the cheap proof: the gateway is always node running server.js. A pid with
// no readable /proc entry (permissions, or a race with the process exiting) is treated as
// NOT ours, so the caller clears the stale file and starts a real one. Failing that way is
// safe — the cost is one wasted start — whereas failing the other way is a false "up".
function pidLooksLikeGateway(pid) {
    if (!pid) return false;
    try {
        // argv, not a substring. `cmd.includes('server.js')` also matches our own MCP
        // process (`.../src/tools/mcp-server.js`) — "mcp-server.js" CONTAINS "server.js" —
        // so an MCP pid would have been accepted as a running gateway. Match the argument.
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        return argv.some((a) => a === 'server.js' || a.endsWith('/server.js'));
    } catch {
        return false;
    }
}

function gatewayRunning(port) {
    const key = gatewayKey(port);
    const pid = readPid(key);
    if (!isAlive(pid)) { if (pid) clearPid(key); return null; }
    // Alive but not ours: a reused pid. Clear it rather than report a gateway that is not
    // running — the caller then starts one, which is what "not running" should do.
    if (!pidLooksLikeGateway(pid)) { clearPid(key); return null; }
    return pid;
}

