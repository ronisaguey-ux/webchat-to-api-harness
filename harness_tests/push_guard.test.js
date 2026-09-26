'use strict';
// run_bash must never push to main/master. The old check split the command on spaces
// and took the last non-flag word as "the branch", so each command below reached git
// (measured 2026-09-25): `HEAD:main` and `main:main` are not the string "main", `+master`
// has a plus, and in `… main && echo ok` the "branch" was `ok`.
//
// A fake `git` on PATH records every invocation, so the test proves the push never ran —
// not merely that an error string came back.
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
const LOG = path.join(G.TMP, 'git.log');
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, 'git'), `#!/bin/sh\necho "$@" >> '${LOG}'\n`, { mode: 0o755 });
process.env.PATH = BIN + path.delimiter + process.env.PATH;
fs.mkdirSync(path.join(G.WORK, 'r'), { recursive: true });

async function bash(command) {
    try { fs.unlinkSync(LOG); } catch { /* first run */ }
    const r = await tools.executeTool('run_bash', { command });
    const ran = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    return { r, ran };
}

const DENY = [
    'git push origin HEAD:main',
    'git push origin main:main',
    'git push origin +master',
    'git push -u origin main && echo ok',
    'cd r && git push origin main;',
    'git push origin feature:refs/heads/master',
    'git push --all origin',
    'git push origin HEAD',
    'git -C r push origin main',
    'bash -c "git push origin main"',
];
for (const command of DENY) {
    test(`denied, never reaches git: ${command}`, async () => {
        const { r, ran } = await bash(command);
        assert.strictEqual(r.success, false, JSON.stringify(r).slice(0, 300));
        assert.match(r.error, /DENIED: git push/);
        assert.strictEqual(ran.includes('push'), false, 'git push ran: ' + ran);
    });
}

const ALLOW = [
    'git push origin fix/slop-immunity',
    'git push -u origin feature-x && echo pushed',
    'git push origin HEAD:refs/heads/feature-y',
    'git log --oneline | grep push',
];
for (const command of ALLOW) {
    test(`allowed: ${command}`, async () => {
        const { r } = await bash(command);
        assert.notStrictEqual(r.error && /DENIED/.test(r.error), true, r.error);
    });
}
test.after(() => G.stop());
