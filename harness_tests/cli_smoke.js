'use strict';
//
// cli_smoke.js — drive the real TUI in a real PTY and assert it renders.
//
// The interactive screens cannot be tested by requiring modules: they read keys and write
// escapes. This spawns the actual CLI under a pseudo-terminal, feeds it keystrokes, and
// checks the rendered screens. It never launches a browser or starts a gateway.
//
// ★ WHY THIS WAS REWRITTEN (2026-09-25). It was passing 1/14 at HEAD, and the cause was
// not a bug in the CLI — it was that this file had drifted from the product:
//
//   * The opening is a WALK that runs EVERY launch now (greeting → platform → tour choice),
//     by design: it used to be skipped once the platform had been answered, so the greeting
//     was never seen again. This file still assumed entering the dashboard directly, so all
//     its keystrokes landed on the wrong screens.
//   * The dashboard's menu had been reordered ("Gates & sandbox" is no longer a top-level
//     row — it is a group inside Config), so navigation-by-arrow-count was aiming at the
//     wrong item even after the walk.
//
// A smoke test that fails for reasons unrelated to the code is worse than no smoke test: it
// teaches everyone to ignore it. So the walk and the menu are encoded here explicitly, and
// the counts are asserted against the rendered screen rather than assumed.
//
// ★ It also runs against a SCRATCH config and state dir. It used to use the live ones, which
// means it wrote real settings (the platform answer) as a side effect of a test. A test must
// never mutate live state — that same mistake elsewhere in this repo corrupted an installed
// launch.
//
// Run: node harness_tests/cli_smoke.js

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const results = [];
const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// A throwaway config so nothing here touches the installed one. `platform` is pre-set to
// linux so the walk's platform screen shows it as current AND the one-time setup prompt
// (which appears only when no platform has been chosen) does not interrupt the script.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-smoke-'));
const CFG = path.join(SCRATCH, 'harness.config.json');
fs.writeFileSync(CFG, JSON.stringify({
    platform: 'linux',
    _README: 'scratch config for cli_smoke.js — never the live one',
}, null, 2));

// The opening walk, as Enter presses that reach the dashboard.
//
// Measured, not assumed: TWO Enters. The first passes the greeting and the platform
// question (the platform menu opens with the current answer already selected, so Enter
// accepts it and moves on), and the second accepts "Straight to it" on the tour question.
// This was three in the first draft of this rewrite, and the extra Enter silently opened
// the Webchats row instead of landing on the dashboard — which is why the counts here are
// stated with their evidence rather than guessed.
const TO_DASHBOARD = ['\r', '\r'];
// Dashboard rows, in render order. Encoded so a reorder is a visible edit here rather than a
// silently mis-aimed keystroke.
const DOWN = '\u001b[B';
const dashboardDowns = (to) => Array.from({ length: to }, () => DOWN);
const ROW = { webchats: 0, harnesses: 1, mode: 2, launch: 3, tools: 4, config: 5, mcp: 6, logs: 7, doctor: 8, tour: 9 };
// Groups inside Config, in schema order.
const GROUP = { platform: 0, dashboard: 1, permission: 2, tools: 3, prompt: 4, mcp: 5, ui: 6, site: 7, gates: 8, loops: 9, behaviour: 10, advanced: 11 };

// Collect PTY output for a fixed script of keypresses.
function drive(keys, { timeoutMs = 12000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn('script', ['-qec', `node ${path.join('bin', 'webchat.js')}`, '/dev/null'], {
            cwd: REPO,
            env: {
                ...process.env,
                TERM: 'xterm-256color', COLUMNS: '100', LINES: '40',
                // The two overrides that keep this off the live install.
                HARNESS_CONFIG: CFG,
                WEBCHAT_STATE_DIR: SCRATCH,
            },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });

        let i = 0;
        // One key per interval, because readKey resolves one key per read — writing a chunk
        // of keys at once delivers only the first (and an arrow split across reads used to be
        // read as a lone ESC that navigated BACK).
        const timer = setInterval(() => {
            if (i >= keys.length) return;
            try { child.stdin.write(keys[i]); } catch { /* exited */ }
            i += 1;
        }, 700);

        setTimeout(() => {
            clearInterval(timer);
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            // Strip ANSI before matching. Every screen redraws with colour and cursor moves
            // interleaved, so a plain regex over the raw stream misses phrases that ARE on
            // screen — measured: "Gates & sandbox" rendered correctly while the assertion
            // reported a miss, because escape bytes sat between the words.
            resolve(out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, ''));
        }, timeoutMs);
    });
}

(async () => {
    // ── 1. the opening walk renders, in order ───────────────────────────────
    const walk = await drive(['q'], { timeoutMs: 4000 });
    record('the greeting renders', /welcome to the webchat-to-api harness/.test(walk), '');
    record('the greeting explains what it is', /ordinary model API/.test(walk), '');
    record('the platform question is asked', /Which system is your agent running on/.test(walk), '');
    record('the platform question offers both systems', /Linux/.test(walk) && /Windows/.test(walk), '');
    record('the walk did NOT show the one-off setup prompt', !/Let your own agent wire this up/.test(walk),
        'platform is already chosen in the scratch config, so it must not interrupt');
    record('menu cursor is drawn', /❯/.test(walk), '');

    // ── 2. the dashboard renders ────────────────────────────────────────────
    const main = await drive([...TO_DASHBOARD, 'q'], { timeoutMs: 6000 });
    record('dashboard asks what to do', /What do you want to do/.test(main), '');
    record('dashboard shows the webchats row', /Webchats/.test(main), '');
    record('dashboard shows the config row', /Config/.test(main), '');
    record('dashboard shows the agent access row', /Agent access \(MCP\)/.test(main), '');
    record('dashboard shows the doctor row', /Doctor/.test(main), '');
    // The gateway row is the load-bearing part of the panel: 'up <url>' or 'stopped'. This
    // whole panel used to render NOTHING when the browser was running (cdpAlive has no
    // `pages` and the render read it), and the failure was swallowed — so asserting its real
    // content is the point, not a formality.
    record('dashboard renders the status panel', /gateway\s+(up\s+http|stopped)/i.test(main),
        'the panel was silently absent while the browser was up');
    record('dashboard status panel names the browser', /browser\s+(running|not running)/i.test(main), '');

    // ── 3. the settings group list renders (Config is the 6th row) ──────────
    const settings = await drive([...TO_DASHBOARD, ...dashboardDowns(ROW.config), '\r', '\u001b', 'q'], { timeoutMs: 12000 });
    record('settings asks which group', /Which group/.test(settings), '');
    record('settings shows the webchat group', /Webchat & connection/.test(settings), '');
    record('settings shows the gates group', /Gates & sandbox/.test(settings), '');
    record('settings shows the loops group', /Tool-call loops/.test(settings), '');
    record('settings counts each group', /\d+ setting\(s\)/.test(settings), '');

    // ── 4. the gates group opens and states the posture ─────────────────────
    // Opening a group renders its SETTINGS LIST — this is not the 'Current posture' screen.
    // 'not a kernel jail' is the group's blurb on the previous screen, so asserting it here
    // passed for the wrong reason until this was checked against a captured screen.
    const gates = await drive([...TO_DASHBOARD, ...dashboardDowns(ROW.config), '\r',
        ...Array.from({ length: GROUP.gates }, () => DOWN), '\r', '\u001b', '\u001b', 'q'], { timeoutMs: 18000 });
    record('gates group opens', /Gates & sandbox/.test(gates), '');
    record('gates group lists the bash gate', /Allow run_bash/.test(gates), '');
    record('gates group lists the sandbox switch', /Enable sandbox/.test(gates), '');

    // ── 5. agent access renders and offers the setup prompt ─────────────────
    const mcpMenu = await drive([...TO_DASHBOARD, ...dashboardDowns(ROW.mcp), '\r', '\u001b', 'q'], { timeoutMs: 12000 });
    record('agent access screen renders', /Let any agent drive this harness/.test(mcpMenu), '');
    record('agent access offers the setup prompt', /setup prompt/i.test(mcpMenu), '');
    record('agent access states the tool count', /\d+ tools are exposed/.test(mcpMenu), '');
    record('agent access offers a raw config block', /config block/i.test(mcpMenu), '');

    // ── 6. the setup prompt screen renders, generated for the chosen platform ─
    const prompt = await drive([...TO_DASHBOARD, ...dashboardDowns(ROW.mcp), '\r', '\r', '\u001b', '\u001b', 'q'], { timeoutMs: 13000 });
    record('setup prompt screen renders', /Let your own agent wire this up/.test(prompt), '');
    record('setup prompt is generated for the chosen platform', /Linux \(bash, forward slashes\)/.test(prompt),
        'the scratch config says linux, so the prompt must say linux');
    record('setup prompt offers copy and save', /Copy the prompt/.test(prompt) && /Save it to a file/.test(prompt), '');
    record('setup prompt names the tool count', /\d+ tools\)/.test(prompt), '');

    fs.rmSync(SCRATCH, { recursive: true, force: true });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();
