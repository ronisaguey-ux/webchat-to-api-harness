'use strict';
//
// "Broad command output can be large, contributing to repeated follow-up turns."
//
// A single run_bash can return execMaxBuffer (4 MB), and every byte of it is re-sent
// on EVERY later round of the same turn. The compactor is what caps that, and it was
// OFF by default — so the default configuration paid the full cost.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-cap-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');

function freshConfig(env = {}) {
    for (const k of Object.keys(require.cache)) {
        if (/(config|master_config|compactor)\.js$/.test(k)) delete require.cache[k];
    }
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const cfg = require(path.join(__dirname, '..', 'src', 'core', 'config.js'));
    const comp = require(path.join(__dirname, '..', 'src', 'runtime', 'compactor.js'));
    return { cfg, comp, restore: () => { process.env = { ...saved }; } };
}

test('tool-result compaction is on unless it is explicitly turned off', () => {
    fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
    const { cfg, restore } = freshConfig();
    try {
        assert.strictEqual(cfg.toolCompactor, true,
            'OFF was the default, so a 4MB run_bash was re-sent on every later round');
    } finally { restore(); }
});

test('an explicit off is still honoured', () => {
    fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
    const { cfg, restore } = freshConfig({ TOOL_COMPACTOR: 'false' });
    try {
        assert.strictEqual(cfg.toolCompactor, false);
    } finally { restore(); }
});

test('a huge bash result is capped before it reaches the tab', () => {
    fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
    const { cfg, comp, restore } = freshConfig();
    try {
        const huge = { success: true, stdout: 'x'.repeat(4_000_000), stderr: '' };
        const { result, compacted } = comp.compactResult(huge, cfg.compactor);
        assert.strictEqual(compacted, true, 'a 4MB result must be compacted');
        assert.ok(result.stdout.length < 20_000,
            `compaction must bring it down to a fraction, got ${result.stdout.length}`);
    } finally { restore(); }
});

test('small results and errors are never touched', () => {
    fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');
    const { cfg, comp, restore } = freshConfig();
    try {
        // Compaction exists to stop a flood, not to rewrite normal work — and an
        // error is exactly what the model needs in full to fix it.
        assert.strictEqual(comp.compactResult({ success: true, stdout: 'ok' }, cfg.compactor).compacted, false);
        const err = { success: false, error: 'boom', stdout: 'y'.repeat(500_000) };
        assert.strictEqual(comp.compactResult(err, cfg.compactor).compacted, false);
    } finally { restore(); }
});

test('read_file is exempt from compaction (data-loss guard)', () => {
    // read_file caps itself at 200K and FLAGS it (truncated:true + totalLength).
    // Compacting it to 10K loses the middle with no flag at all, so the model cannot
    // tell a short file from a clipped one — and a model that writes the file back
    // destroys everything it did not see. This is why the exemption is in the
    // shipped path and not just measured here.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    const fn = src.slice(src.indexOf('function maybeCompactResult'), src.indexOf('function maybeCompactResult') + 900);
    assert.match(fn, /call\.toolName === 'read_file'\)\s*return result/,
        'maybeCompactResult must return a read_file result untouched');
});
