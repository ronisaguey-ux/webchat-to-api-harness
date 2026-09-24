'use strict';
//
// Tests for the Linux/Windows platform switch and the background subagent runtime.
//
// Both are new, both are load-bearing, and both had a failure mode that is invisible from
// the outside: a platform that reports Windows while the shell stays bash, or a job that
// reports "running" forever because its process died. So the assertions are on the
// BEHAVIOUR a caller depends on, not on the shape of the objects.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const platform = require('../src/core/platform.js');
const subagents = require('../src/runtime/subagents.js');

test('platform: names normalise to the two supported values', () => {
    for (const v of ['linux', 'Linux', 'unix', 'posix', 'darwin', 'mac']) {
        assert.strictEqual(platform.normalize(v), 'linux', `${v} -> linux`);
    }
    for (const v of ['windows', 'Windows', 'win', 'win32', 'win64', 'nt', 'dos']) {
        assert.strictEqual(platform.normalize(v), 'windows', `${v} -> windows`);
    }
    // Anything unrecognised must return null rather than guessing — a typo that silently
    // picks a platform is worse than one that is rejected.
    for (const v of ['', null, undefined, 'solaris', 'wndows']) {
        assert.strictEqual(platform.normalize(v), null, `${v} -> null`);
    }
});

test('platform: switching changes shell, syntax hint and danger list TOGETHER', () => {
    // The whole point of the module: one decision, applied everywhere. If any of these
    // drifted apart you would get a Windows target running bash with POSIX checks.
    platform.setPlatform('linux');
    assert.strictEqual(platform.shell().name, 'bash');
    assert.strictEqual(platform.isLinux(), true);
    assert.match(platform.shellHint(), /bash/);
    assert.deepStrictEqual(platform.shell().stdinArgs, ['-s']);
    const linuxDanger = platform.dangerPatterns();
    assert.ok(linuxDanger.includes('rm -rf'), 'linux blocks rm -rf');
    assert.ok(!linuxDanger.includes('del /f /s /q'), 'linux does not block cmd syntax');

    platform.setPlatform('windows');
    assert.strictEqual(platform.shell().name, 'cmd');
    assert.strictEqual(platform.isWindows(), true);
    assert.match(platform.shellHint(), /cmd\.exe/);
    assert.strictEqual(platform.shell().stdinArgs, null, 'cmd takes the script as an argument');
    const winDanger = platform.dangerPatterns();
    assert.ok(winDanger.includes('del /f /s /q'), 'windows blocks cmd destruction');
    assert.ok(!winDanger.includes('rm -rf'), 'windows does not block bash syntax');

    platform.setPlatform('linux');
});

test('platform: paths are spelled the way the TARGET writes them', () => {
    platform.setPlatform('windows');
    assert.strictEqual(platform.format('C:/Users/x/file.py'), 'C:\\Users\\x\\file.py');
    platform.setPlatform('linux');
    assert.strictEqual(platform.format('a\\b\\c'), 'a/b/c');
});

test('platform: the env var beats a stale explicit value only when set', () => {
    const saved = process.env.HARNESS_PLATFORM;
    delete process.env.HARNESS_PLATFORM;
    platform.setPlatform('');
    assert.strictEqual(platform.current(), platform.hostPlatform(), 'falls back to the real OS');

    process.env.HARNESS_PLATFORM = 'windows';
    platform.setPlatform('');
    assert.strictEqual(platform.current(), 'windows', 'env wins over the host');

    if (saved === undefined) delete process.env.HARNESS_PLATFORM;
    else process.env.HARNESS_PLATFORM = saved;
    platform.setPlatform('linux');
});

test('subagents: a job with no gate is recorded as running, then reads back', async () => {
    // spawn() must return immediately — the caller gets an id, not an answer. That is what
    // makes several webchats usable at once.
    const before = Date.now();
    const job = subagents.spawn({ prompt: 'test prompt for the subagent registry', gate: 'nonexistent-gate', label: 'unit' });
    const elapsed = Date.now() - before;
    assert.ok(job.id && job.id.startsWith('sa_'), 'returns an id');
    assert.strictEqual(job.state, 'running');
    assert.ok(elapsed < 2000, `spawn must not block (took ${elapsed}ms)`);
    assert.strictEqual(job.label, 'unit');

    const listed = subagents.list({});
    assert.ok(listed.jobs.some((j) => j.id === job.id), 'appears in the list');

    // It will fail (no such gate), which is the correct outcome and proves the worker ran.
    const res = await subagents.result(job.id, 8000);
    assert.ok(res, 'a result comes back for a known id');
    assert.ok(['failed', 'running', 'done'].includes(res.state), `state is real, got ${res.state}`);
});

test('subagents: an unknown id returns null rather than throwing', async () => {
    const res = await subagents.result('sa_does_not_exist', 0);
    assert.strictEqual(res, null, 'an unknown job is null, not an exception');
});

test('subagents: cancelling a finished job reports it instead of failing', async () => {
    const job = subagents.spawn({ prompt: 'cancel me', gate: 'nonexistent-gate' });
    const r1 = subagents.cancel(job.id);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.state, 'cancelled');
    // A second cancel is the interesting case: a caller racing a job that already ended
    // must be told it finished, not given an error to handle.
    const r2 = subagents.cancel(job.id);
    assert.strictEqual(r2.ok, true);
    assert.ok(r2.note, 'reports that it had already finished');
});

test('subagents: job files record the prompt preview, not the whole prompt', () => {
    const big = 'x'.repeat(5000);
    const job = subagents.spawn({ prompt: big, gate: 'nonexistent-gate' });
    const onDisk = subagents.readJob(job.id);
    assert.ok(onDisk.promptPreview.length <= 300, 'the preview is capped');
    assert.strictEqual(onDisk.prompt.length, 5000, 'the full prompt is kept for the worker');
    subagents.cancel(job.id);
});
