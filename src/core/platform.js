'use strict';
//
// platform.js — ONE place that decides whether this harness behaves as Linux or Windows.
//
// Why a module and not a pile of `process.platform` checks scattered through the tools:
// a platform is not a single fact, it is a SET of them (which shell runs a command, how a
// path is spelled, which roots the sandbox allows, which command patterns are dangerous).
// Scattered checks drift — one of them keeps using `/bin/bash` on Windows and the failure
// appears as "run_bash does not work" with no clue why. Everything reads this module, so
// switching the setting switches all of it together.
//
// The setting is explicit rather than taken from `process.platform` on purpose: an agent
// may be *told* to produce Windows-compatible work (paths, commands, line endings) while
// the harness itself runs on Linux. `process.platform` cannot express that, and guessing
// from it is how you get a Linux command handed to a Windows target.
//
// Precedence:  HARNESS_PLATFORM env  >  harness.config.json `platform`  >  the real OS.

const os = require('os');
const path = require('path');

const LINUX = 'linux';
const WINDOWS = 'windows';
const VALID = [LINUX, WINDOWS];

function normalize(value) {
    const v = String(value || '').trim().toLowerCase();
    if (['win', 'windows', 'win32', 'win64', 'nt', 'dos'].includes(v)) return WINDOWS;
    if (['linux', 'unix', 'posix', 'darwin', 'mac', 'macos', 'osx'].includes(v)) return LINUX;
    return null;
}

// The real OS, used only as the last resort.
function hostPlatform() {
    return process.platform === 'win32' ? WINDOWS : LINUX;
}

let _explicit = null;

// Called by config.js once the config file is read, and directly by tests.
function setPlatform(value) {
    const n = normalize(value);
    _explicit = n;
    return current();
}

function current() {
    if (_explicit) return _explicit;
    const fromEnv = normalize(process.env.HARNESS_PLATFORM);
    if (fromEnv) return fromEnv;
    return hostPlatform();
}

function isWindows() { return current() === WINDOWS; }
function isLinux() { return current() === LINUX; }

// ── Shell ────────────────────────────────────────────────────────────────────
// The command runner spawns `shell.cmd` with `shell.args(script)`. On Linux that is
// `bash -lc` so the user's PATH and aliases behave; on Windows it is `cmd /d /s /c`
// (PowerShell is deliberately NOT the default: `cmd` accepts the commands models
// actually emit, and a PowerShell parser turns a stray `&&` or `2>&1` into a hard error
// that reads like the tool is broken).
function shell() {
    if (isWindows()) {
        const comspec = process.env.ComSpec || 'cmd.exe';
        return {
            cmd: comspec,
            args: (script) => ['/d', '/s', '/c', script],
            // cmd.exe has no `-s`: it takes the script as an argument, so the runner must
            // spawn with argv rather than piping to stdin. Exposed as `stdinArgs === null`
            // so the caller branches on capability, not on the platform name.
            stdinArgs: null,
            name: 'cmd',
        };
    }
    return {
        cmd: process.env.SHELL && process.env.SHELL.endsWith('bash') ? process.env.SHELL : '/bin/bash',
        args: (script) => ['-lc', script],
        // `bash -s` reads the script from stdin. That is deliberate: `bash -c "<cmd>"`
        // puts the command text in the wrapper's own cmdline, so a `pkill -f <name>`
        // inside the command matched the wrapper itself and killed it.
        stdinArgs: ['-s'],
        name: 'bash',
    };
}

// ── Paths ────────────────────────────────────────────────────────────────────
// The harness runs on one OS but may be TARGETING another, so two different things are
// needed: the real path module for its own filesystem work, and a way to spell a path the
// way the target OS expects. Mixing them is the classic bug (a `C:\` string fed to
// path.resolve on Linux produces a relative path with a literal backslash).
function pathModule() {
    // The harness's OWN filesystem is always the host's — it is running here.
    return path;
}

function join(...parts) {
    return path.join(...parts);
}

// Spell a path the way the ACTIVE platform writes it. Purely cosmetic unless the value
// is handed to a command on that platform, which is exactly when it matters.
function format(p) {
    const s = String(p == null ? '' : p);
    if (isWindows()) return s.replace(/\//g, '\\');
    return s.replace(/\\/g, '/');
}

// Where a project's tree normally lives on each platform. Used to seed the sandbox and
// the default workspace root when nothing is configured.
function defaultRoots(workspaceRoot) {
    const bases = [];
    if (workspaceRoot) bases.push(workspaceRoot);
    if (isWindows()) {
        const home = os.homedir();
        const drive = (process.env.SystemDrive || 'C:');
        // Temp is spelled differently and is the one root the tools always need.
        bases.push(path.join(home, 'AppData', 'Local', 'Temp'));
        bases.push(path.join(drive + path.sep, 'tmp'));
    } else {
        bases.push('/tmp');
        bases.push(os.tmpdir());
    }
    return [...new Set(bases.filter(Boolean))];
}

// ── Command safety ───────────────────────────────────────────────────────────
// The deny-list is platform-specific: `rm -rf` means nothing to cmd, and `del /f /s /q`
// means nothing to bash. Keeping one list and applying it everywhere lets a destructive
// Windows command through while looking guarded.
const DANGER_LINUX = [
    'pkill -f', 'node -e', 'node -p', 'rm -rf',
    'settings_backup.json', 'ghp_', 'TELEGRAM_TOKEN', 'BOT_TOKEN',
];
const DANGER_WINDOWS = [
    'format ', 'del /f /s /q', 'rd /s /q', 'rmdir /s /q',
    'Remove-Item -Recurse -Force', 'settings_backup.json', 'ghp_',
    'TELEGRAM_TOKEN', 'BOT_TOKEN',
];

function dangerPatterns() {
    return isWindows() ? DANGER_WINDOWS : DANGER_LINUX;
}

// A hint for the model about which command syntax to emit. Injected into the tool
// description so the model does not have to infer it from the error.
function shellHint() {
    if (isWindows()) {
        return 'Commands run in cmd.exe, so use Windows syntax (dir, type, findstr, %VAR%). '
            + 'Do NOT emit bash-only syntax such as export, $( ), or forward-slash paths.';
    }
    return 'Commands run in bash, so use POSIX syntax (ls, cat, grep, $VAR). '
        + 'Do NOT emit cmd.exe syntax such as dir /s or %VAR%.';
}

module.exports = {
    LINUX, WINDOWS, VALID,
    normalize, hostPlatform, setPlatform, current, isWindows, isLinux,
    shell, shellHint,
    pathModule, join, format, defaultRoots,
    dangerPatterns,
};
