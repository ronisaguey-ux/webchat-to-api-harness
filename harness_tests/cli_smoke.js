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
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const results = [];
const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// Collect PTY output for a fixed script of keypresses.
function drive(keys, { timeoutMs = 12000, args = [] } = {}) {
    return new Promise((resolve) => {
        const child = spawn('script', ['-qec', `node ${path.join('bin', 'webchat.js')} ${args.join(' ')}`, '/dev/null'], {
            cwd: REPO,
            env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '100', LINES: '40', NO_COLOR: '' },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });

        let i = 0;
        const timer = setInterval(() => {
            if (i >= keys.length) return;
            try { child.stdin.write(keys[i]); } catch { /* exited */ }
            i += 1;
        }, 700);

        setTimeout(() => {
            clearInterval(timer);
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

(async () => {
    // ── 1. the main menu renders ────────────────────────────────────────────
    const main = await drive(['q'], { timeoutMs: 4000 });
    record('main menu renders the title', /webchat/.test(main), 'found the header');
    record('main menu lists the settings entry', /All settings/.test(main), '');
    record('main menu lists the start entry', /Start the harness/.test(main), '');
    record('main menu shows live status', /Status/.test(main) && /gateway/.test(main), '');
    record('menu cursor is drawn', /❯/.test(main), '');

    // ── 2. navigating to Gates renders the posture ─────────────────────────
    // Menu order: 0 Webchat & browser, 1 Gates & sandbox, 2 All settings, …
    // so Gates is ONE down, not two.
    const gates = await drive(['\u001b[B', '\r', '\u001b', 'q'], { timeoutMs: 6000 });
    record('gates screen renders', /Current posture/.test(gates), '');
    record('gates shows the bash gate', /run_bash/.test(gates), '');
    record('gates warns it is not a jail', /not a kernel jail/.test(gates), '');

    // ── 3. navigating to All settings renders the grouped schema ───────────
    const settings = await drive(['\u001b[B', '\u001b[B', '\r', '\u001b', 'q'], { timeoutMs: 6000 });
    record('settings group list renders', /Which group/.test(settings), '');
    record('settings shows the webchat group', /Webchat & connection/.test(settings), '');
    record('settings shows the gates group', /Gates & sandbox/.test(settings), '');
    record('settings shows the loops group', /Tool-call loops/.test(settings), '');
    record('settings counts each group', /\d+ setting\(s\)/.test(settings), '');

    // ── 4. the env-shadowing warning is surfaced, not hidden ───────────────
    record('env shadowing is reported on the dashboard', /environment variable/.test(main), '');

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();
