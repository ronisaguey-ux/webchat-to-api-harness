'use strict';
// cli_smoke.js — drive the real TUI in a real PTY and assert it renders.
//
// The interactive screens cannot be tested by requiring modules: they read keys
// and write escapes. This spawns the actual CLI under a pseudo-terminal, feeds
// it keystrokes, and checks the rendered screens.
//
// It never launches a browser or starts anything: every path exercised here is
// menu navigation and read-only probes.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

// HERMETIC. The CLI used to run with the caller's real HOME, config and state, so it
// passed only on a machine that had already been through first run — on a fresh clone
// the welcome wizard ("Which system is your agent running on?") took the keys and 12 of
// 14 checks failed — and it could rewrite the owner's real config. Everything it reads
// or writes now lives in a throwaway directory, and the environment is built from
// scratch rather than inherited, so no token or key of the caller's reaches it.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-cli-smoke-'));
const HOME = path.join(SANDBOX, 'home');
for (const d of ['home', 'state', 'workspace', 'home/.config', 'home/.local/state', 'home/.local/share', 'home/.cache']) {
    fs.mkdirSync(path.join(SANDBOX, d), { recursive: true });
}
const CONFIG = path.join(SANDBOX, 'harness.config.json');
// The gateway and CDP ports point at ports nothing listens on, so a harness or browser
// running on this machine cannot leak into the screens (both are filled in below).
const ENV = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    HOME,
    USERPROFILE: HOME,
    XDG_CONFIG_HOME: path.join(HOME, '.config'),
    XDG_STATE_HOME: path.join(HOME, '.local', 'state'),
    XDG_DATA_HOME: path.join(HOME, '.local', 'share'),
    XDG_CACHE_HOME: path.join(HOME, '.cache'),
    HARNESS_CONFIG: CONFIG,
    WEBCHAT_STATE_DIR: path.join(SANDBOX, 'state'),
    WORKSPACE_ROOT: path.join(SANDBOX, 'workspace'),
    BASH_TOOL_LOG: path.join(SANDBOX, 'bash_tool_log.jsonl'),
    // One deliberate env override, so check 4 (the shadowing warning) has something to
    // report on every machine instead of depending on the caller's shell.
    MAX_TOOL_ROUNDS: '8',
    CDP_PORT: '',
    TERM: 'xterm-256color',
    COLUMNS: '100',
    LINES: '40',
};
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });
const results = [];
const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// Collect PTY output for a fixed script of keypresses.
function drive(keys, { timeoutMs = 12000, args = [], startDelayMs = 1500 } = {}) {
    return new Promise((resolve) => {
        const child = spawn('script', ['-qec', `node ${path.join('bin', 'webchat.js')} ${args.join(' ')}`, '/dev/null'], {
            cwd: REPO,
            env: ENV,
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });

        // Keys start after the first screen has had time to draw; one every 500ms after.
        let i = 0;
        let timer = null;
        const start = setTimeout(() => {
            timer = setInterval(() => {
                if (i >= keys.length) return;
                try { child.stdin.write(keys[i]); } catch { /* exited */ }
                i += 1;
            }, 500);
        }, startDelayMs);

        setTimeout(() => {
            clearTimeout(start);
            if (timer) clearInterval(timer);
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            // Strip ANSI before returning. Every screen redraws with colour and
            // cursor moves interleaved, so a plain regex over the raw stream
            // fails to match phrases that ARE on screen — measured: "Gates &
            // sandbox" rendered correctly while the assertion reported a miss,
            // because escape bytes sat between the words.
            resolve(out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, ''));
        }, timeoutMs);
    });
}

// A port nothing is listening on: bind it, read it, release it.
function deadPort() {
    return new Promise((resolve) => {
        const srv = require('net').createServer().listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const ENTER = '\r';
const DOWN = '\u001b[B';
const CTRL_C = '\u0003';
const down = (n) => Array(n).fill(DOWN);
// The opening walk runs on EVERY launch: the platform question (Linux is already the
// answer, so Enter keeps it), then "Want a tour?" (Enter = straight to it).
const OPENING = [ENTER, ENTER];

(async () => {
    // The PTY comes from util-linux `script`. Without it every check would fail with an
    // empty screen, which reads as a broken CLI — say what is missing instead.
    const probe = require('child_process').spawnSync('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
        console.log('FAIL  cli_smoke needs util-linux `script` (a PTY) on PATH — not found or not working');
        process.exit(1);
    }
    // First run already answered — the smoke test is about the menus, not the wizard.
    fs.writeFileSync(CONFIG, JSON.stringify({ platform: 'linux', server: { port: await deadPort() } }, null, 2));
    ENV.CDP_PORT = String(await deadPort());

    // ── 1. the opening walk, then the dashboard ────────────────────────────
    const main = await drive([...OPENING, CTRL_C], { timeoutMs: 7000 });
    record('opening asks the platform', /Which system is your agent running on\?/.test(main), '');
    record('opening offers the tour', /Want a tour\?/.test(main), '');
    record('dashboard renders the title', /webchat/.test(main), '');
    record('dashboard lists the config entry', /Config\s+every setting/.test(main), '');
    record('dashboard lists the launch entry', /Launch/.test(main), '');
    record('dashboard shows live status', /gateway\s+stopped/.test(main) && /browser\s+not running/.test(main), '');
    record('menu cursor is drawn', /❯/.test(main), '');
    // The one env override in ENV (MAX_TOOL_ROUNDS) must be called out, not hidden.
    record('env shadowing is reported on the dashboard', /come from an environment variable/.test(main), '');

    // ── 2. Config renders the grouped schema ───────────────────────────────
    // Dashboard order: Webchats, Agentic harness, Permission mode, Launch, Tools, Config…
    const settings = await drive([...OPENING, ...down(5), ENTER, CTRL_C], { timeoutMs: 9000 });
    record('config group list renders', /Which group\?/.test(settings), '');
    record('config shows the webchat group', /Webchat & connection/.test(settings), '');
    record('config shows the gates group', /Gates & sandbox/.test(settings), '');
    record('config shows the loops group', /Tool-call loops/.test(settings), '');
    record('config counts each group', /\d+ setting\(s\)/.test(settings), '');
    record('config marks the env-shadowed setting', /1 env-shadowed/.test(settings), '');

    // ── 3. the Gates & sandbox group lists the bash gate ───────────────────
    // Group order: Platform, Dashboard, Permission mode, Tools, System prompt, MCP servers,
    // Appearance, Webchat & connection, Gates & sandbox…
    const gates = await drive([...OPENING, ...down(5), ENTER, ...down(8), ENTER, CTRL_C], { timeoutMs: 12000 });
    record('gates group shows the bash gate', /Allow run_bash/.test(gates), '');
    record('gates group shows the sandbox roots', /Sandbox roots/.test(gates), '');
    record('gates warns it is not a jail', /not a kernel jail/.test(gates), '');

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();
