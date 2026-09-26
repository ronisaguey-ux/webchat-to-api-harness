'use strict';
// The run_bash deny-list must match the command that runs, not a substring. Measured
// 2026-09-25 with the text list: `rm -r -f`, `rm  -rf` (two spaces), `rm -fr` and
// `find … -delete` ran, while `grep -r halting src/` and `echo reboot notes` were
// refused for containing "halt"/"reboot".
//
// Every program named here is shadowed by a recording fake on PATH, so a command the
// old guard let through only writes a log line — nothing is ever deleted.
process.env.BASH_ALLOWED = 'true';
process.env.SANDBOX_ALLOW_BASH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('./_gateway');
const tools = require('../src/tools/tools');

// stdout is the test runner's IPC channel; the tool log must not write into it.
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');

const BIN = path.join(G.TMP, 'bin');
const LOG = path.join(G.TMP, 'ran.log');
fs.mkdirSync(BIN, { recursive: true });
for (const prog of ['rm', 'find', 'shutdown', 'reboot', 'grep', 'mkfs.ext4', 'dd', 'systemctl']) {
    fs.writeFileSync(path.join(BIN, prog), `#!/bin/sh\necho "${prog} $*" >> '${LOG}'\n`, { mode: 0o755 });
}
process.env.PATH = BIN + path.delimiter + process.env.PATH;

async function bash(command) {
    try { fs.unlinkSync(LOG); } catch { /* first run */ }
    const r = await tools.executeTool('run_bash', { command });
    return { r, ran: fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '' };
}

const DENY = [
    'rm -r -f build',
    'rm  -rf build',
    'rm -fr build',
    'rm -R --force build',
    'find build -delete',
    'find build -name "*.o" -exec rm {} +',
    'cd build && rm -rf .',
    'env LC_ALL=C rm -rf build',
    'sudo shutdown now',
    'systemctl reboot',
    'mkfs.ext4 /dev/null',
];
for (const command of DENY) {
    test(`denied, never runs: ${command}`, async () => {
        const { r, ran } = await bash(command);
        assert.strictEqual(r.success, false, JSON.stringify(r).slice(0, 300));
        assert.match(r.error, /DENIED/);
        assert.strictEqual(ran, '', 'the command ran: ' + ran);
    });
}

const ALLOW = [
    'grep -r halting src/',
    'echo reboot notes',
    'rm -r build',
    'find . -name "*.py"',
    'grep -rn shutdown .',
];
for (const command of ALLOW) {
    test(`allowed: ${command}`, async () => {
        const { r } = await bash(command);
        assert.ok(!(r.error && /DENIED/.test(r.error)), r.error);
    });
}
test.after(() => G.stop());
