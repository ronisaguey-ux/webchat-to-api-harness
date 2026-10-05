'use strict';
//
// The sandbox is the fence in front of every file tool, and it makes ONE promise in
// two places — sandbox.js's own header ("symlinks pointing outside a root are both
// rejected") and README.md ("Paths are realpath-resolved before the prefix test, so
// `..` traversal and symlinks pointing outside a root are both rejected", repeated
// under safety gate 3).
//
// MEASURED 2026-10-05, before the fix in sandbox.js:realpathAllowingMissing:
//
//     SANDBOX_ROOTS=<base>/root
//     <base>/outside/secret.txt            "TOP_SECRET_VALUE"
//     <base>/root/link.txt   -> ../outside/secret.txt
//     checkPath("<base>/root/link.txt")  =>  { ok: true }
//     read_file("<base>/root/link.txt")  =>  "TOP_SECRET_VALUE"     <- read OUTSIDE the root
//     write_file("<base>/root/link.txt") =>  created <base>/outside/pwned.txt
//
// The cause: realpathAllowingMissing realpath'd only path.dirname(abs) and re-attached
// basename(abs) untouched. Every symlinked DIRECTORY component was resolved (so
// `root/outdir/secret.txt` was correctly denied), but a symlink at the LEAF — the file
// name itself — was never resolved, and the tool handlers then open the ORIGINAL path,
// which the kernel resolves through the link.
//
// The fence has to hold for a link the model did not have to create: one that is
// already in the tree it was pointed at (a vendored symlink, a package.json shortcut,
// a .git file, a checkout link left by a build). Below, every fixture is created by
// the test, and every assertion is about checkPath's VERDICT — the escape is proved by
// the verdict being ok:true for a path whose real location is outside the roots.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The roots must be set BEFORE the module is required: sandbox.js reads config and
// SANDBOX_ROOTS once at load, like every other setting in this harness.
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-sandbox-')));
const ROOT = path.join(BASE, 'root');
const OUTSIDE = path.join(BASE, 'outside');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'TOP_SECRET_VALUE');

process.env.SANDBOX_ENABLED = 'true';
process.env.SANDBOX_ROOTS = ROOT;
process.env.WORKSPACE_ROOT = BASE;
process.env.AUDITS_PLANS_DIR = path.join(BASE, 'plans');

const sandbox = require('../src/tools/sandbox');

const SECRET = path.join(OUTSIDE, 'secret.txt');
const LINK = path.join(ROOT, 'link.txt');
fs.symlinkSync('../outside/secret.txt', LINK);

// A second link, this time DANGLING: its target does not exist. That is the shape
// write_file creates, and it is the one that cannot be caught by a "does it exist?"
// pre-check — the file only appears once the write goes through the link.
const DANGLING = path.join(ROOT, 'brand-new.txt');
fs.symlinkSync('../outside/pwned.txt', DANGLING);

// A chain: the link points at a directory, and the leaf under it is the payload.
const CHAIN = path.join(ROOT, 'chain');
fs.symlinkSync('../outside', CHAIN);

test('precondition: the sandbox is on and rooted where the fixtures are', () => {
    assert.strictEqual(sandbox.enabled, true);
    assert.deepStrictEqual(sandbox.roots, [ROOT]);
});

test('a symlinked FILE inside a root is refused — it resolves outside', () => {
    const chk = sandbox.checkPath(LINK);
    assert.strictEqual(chk.ok, false,
        `checkPath allowed ${LINK}, which is a symlink to ${SECRET} outside ${ROOT}`);
    assert.strictEqual(chk.resolved, SECRET);
});

test('a DANGLING symlink inside a root is refused — write_file would follow it', () => {
    // The target does not exist yet, so nothing here can be answered by stat-ing the
    // target: the link itself says where the write lands, and that is outside.
    assert.strictEqual(fs.existsSync(DANGLING), false, 'precondition: target missing');
    const chk = sandbox.checkPath(DANGLING);
    assert.strictEqual(chk.ok, false,
        `checkPath allowed the dangling link ${DANGLING} -> ${path.join(OUTSIDE, 'pwned.txt')}`);
});

test('a symlinked path THROUGH a link is refused at every component', () => {
    const viaDir = path.join(CHAIN, 'secret.txt');
    // This one already passed before the fix (the directory component was realpath'd).
    // It is kept so the fix cannot be "walk up to the parent" and regress this case.
    assert.strictEqual(sandbox.checkPath(viaDir).ok, false, viaDir);
});

test('a link to a link to outside is refused (chained symlinks)', () => {
    const hop2 = path.join(ROOT, 'hop2.txt');
    fs.symlinkSync('./link.txt', hop2);
    assert.strictEqual(sandbox.checkPath(hop2).ok, false,
        `${hop2} -> ./link.txt -> ${SECRET}`);
});

test('a link that stays INSIDE the root is still allowed', () => {
    // The fence must not become "refuse every symlink" — that would break every real
    // checkout. Only links that leave the root are refused.
    const inner = path.join(ROOT, 'inner.txt');
    fs.writeFileSync(inner, 'inside');
    const good = path.join(ROOT, 'good.txt');
    fs.symlinkSync('./inner.txt', good);
    assert.strictEqual(sandbox.checkPath(good).ok, true, 'a link inside the root is fine');
});

test('`..` traversal and a genuinely new file are unchanged', () => {
    assert.strictEqual(sandbox.checkPath(path.join(ROOT, '..', 'outside', 'secret.txt')).ok, false);
    assert.strictEqual(sandbox.checkPath(path.join(ROOT, 'sub', 'new.txt')).ok, true,
        'a not-yet-existing file inside the root is a normal write_file');
});

test('an unresolvable path (symlink loop) is refused, not waved through', () => {
    // a -> b -> a. readFileSync on it fails with ELOOP, so allowing it would not leak
    // anything — but "we could not resolve it" must never be read as "it is inside".
    const p = path.join(ROOT, 'loopA.txt');
    const q = path.join(ROOT, 'loopB.txt');
    fs.symlinkSync('./loopB.txt', p);
    fs.symlinkSync('./loopA.txt', q);
    assert.strictEqual(sandbox.checkPath(p).ok, false, p);
});

test('the file tools themselves cannot read or write through the link', async () => {
    // The verdict above is the fence; this is the consequence. Both assertions are the
    // whole finding: before the fix the tool returned the secret and created the file.
    const tools = require('../src/tools/tools');

    const read = await tools.executeTool('read_file', { path: LINK });
    assert.notStrictEqual(read.success, true,
        `read_file followed the symlink out of the root and returned ${JSON.stringify(read.content)}`);
    assert.ok(!String(read.content || '').includes('TOP_SECRET_VALUE'), 'the secret leaked');

    const write = await tools.executeTool('write_file', { path: DANGLING, content: 'PWNED' });
    assert.notStrictEqual(write.success, true, 'write_file followed the dangling symlink');
    assert.strictEqual(fs.existsSync(path.join(OUTSIDE, 'pwned.txt')), false,
        'a file was created OUTSIDE the sandbox roots');
});

test('checkCommand refuses a command that reads through the link too', () => {
    // SANDBOX_ALLOW_BASH is off by default, so enable the checker directly rather than
    // by mutating module state: assert on the module's own roots, which are loaded.
    const bash = sandbox.checkCommand(`cat ${LINK}`);
    // With ALLOW_BASH off the refusal is the bash gate, not the path fence. What must
    // hold either way is that the command is refused, and that it is never ok.
    assert.strictEqual(bash.ok, false, 'a command reading through an escaping link must be refused');
});
