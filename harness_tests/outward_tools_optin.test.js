// 09-26 (owner): "not git status, that one is fine, but the rest i sent those
// shouldnt be on by default" + "some of those require external mcps so they
// shouldnt even be present unless the user has the mcps for it".
//
// The outward-facing tools are gated on TWO independent conditions and this file
// exists to prove neither one alone is enough:
//
//   OPT-IN   OFF unless the operator switched it on. Messaging the owner or
//            feeding another agent is consent, not a side effect of a file
//            happening to exist.
//   PRESENT  offered only when the file, script or bridge it talks to exists.
//            A tool whose target is absent cannot work, and advertising it
//            teaches the model to try it, fail, and burn a round.
//
// Both directions matter, so every case below is paired: a check that only ever
// turns things off would pass while the feature was unreachable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const SCRATCH = '/tmp/opencode/outward_tools_test';

// The five the owner named. git_status is deliberately NOT here — "that one is fine".
const OUTWARD = [
    'audit_status',
    'telegram_send',
    'send_message_to_main',
    'send_message_to_antigravity',
    'send_telegram_message',
];

// Tools that must keep working. A gate that is too broad is an outage, not security.
const MUST_STAY_ON = ['read_file', 'write_file', 'edit_file', 'list_dir', 'get_time', 'send_message', 'git_status'];

// config.js and tools.js each read their env ONCE at require time, so a case that
// changes the gate has to be a fresh module graph. Only the repo's own modules are
// dropped; the test runner's are left alone.
function loadTools({ env = {}, files = [], bridge = false } = {}) {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    for (const f of files) {
        const p = path.join(SCRATCH, f);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '[]');
    }
    if (bridge) fs.mkdirSync(path.join(SCRATCH, '.config', 'antigravity-bridge'), { recursive: true });

    for (const k of Object.keys(process.env)) {
        if (/^OUTWARD_/.test(k)) delete process.env[k];
    }
    process.env.AUDITS_PLANS_DIR = SCRATCH;
    // os.homedir() follows $HOME on Linux, which is how the antigravity check is steered.
    process.env.HOME = SCRATCH;
    Object.assign(process.env, env);

    for (const k of Object.keys(require.cache)) {
        if (k.startsWith(REPO) && !k.includes('harness_tests')) delete require.cache[k];
    }
    return require(path.join(REPO, 'src', 'tools', 'tools.js'));
}

const on = (tools) => OUTWARD.filter((n) => tools.isToolAvailable(n));

test('no opt-in: every outward tool is off, and nothing else was caught by the gate', () => {
    const tools = loadTools({ bridge: true, files: ['claude_outbox.json', 'claude_inbox.json', 'workflow_state.json'] });
    assert.deepStrictEqual(on(tools), [], 'outward tools must be absent without consent');
    for (const n of MUST_STAY_ON) {
        assert.strictEqual(tools.isToolAvailable(n), true, `${n} must stay available`);
    }
});

test('opt-in alone does not enable a tool whose target is missing', () => {
    // The bridge exists, so antigravity is legitimately on; every other dependency
    // does not, so those stay out even though the operator consented.
    const tools = loadTools({ env: { OUTWARD_TOOLS_ENABLED: 'true' }, bridge: true });
    assert.deepStrictEqual(on(tools), ['send_message_to_antigravity']);
});

test('a present target alone does not enable a tool without opt-in', () => {
    const tools = loadTools({ files: ['claude_outbox.json', 'workflow_state.json', 'audit_state.json'], bridge: true });
    assert.deepStrictEqual(on(tools), [], 'dependency present is not consent');
});

test('opt-in + present target offers the tool', () => {
    const tools = loadTools({
        env: { OUTWARD_TOOLS_ENABLED: 'true' },
        files: ['claude_outbox.json', 'claude_inbox.json', 'workflow_state.json', 'audit_state.json'],
        bridge: true,
    });
    const available = on(tools);
    for (const n of ['audit_status', 'telegram_send', 'send_message_to_main', 'send_message_to_antigravity']) {
        assert.ok(available.includes(n), `${n} should be offered once opted in and its target exists`);
    }
});

test('a single tool can be enabled alone without opening the whole set', () => {
    const tools = loadTools({ env: { OUTWARD_TOOL_TELEGRAM_SEND: 'true' }, files: ['claude_outbox.json'] });
    assert.deepStrictEqual(on(tools), ['telegram_send']);
});

test('the master switch cannot override an explicit per-tool OFF', () => {
    // An explicit "no" for one tool has to win, or a per-tool switch is decorative.
    const tools = loadTools({
        env: { OUTWARD_TOOLS_ENABLED: 'true', OUTWARD_TOOL_TELEGRAM_SEND: 'false' },
        files: ['claude_outbox.json'],
    });
    assert.ok(!on(tools).includes('telegram_send'), 'explicit false must beat the master');
});

test('a dependency predicate that throws fails CLOSED', () => {
    // A missing target is not a reason to advertise the tool. Simulated by pointing
    // AUDITS_PLANS_DIR at a path that cannot be created, so existsSync/os calls blow up.
    const broken = '\u0000not-a-path';
    const tools = loadTools({ env: { OUTWARD_TOOLS_ENABLED: 'true', AUDITS_PLANS_DIR: broken } });
    assert.ok(!on(tools).includes('telegram_send'), 'a throwing predicate must not offer the tool');
});

test('the gate covers exactly the five the owner named, and git_status is untouched', () => {
    const tools = loadTools({});
    // The gate lives on the RAW definitions: getToolDefinitions() strips `available`
    // by design (it exposes only the schema), so reading the gate off it sees nothing.
    const gated = tools.TOOL_DEFINITIONS.filter((d) => typeof d.available === 'function').map((d) => d.name);
    for (const n of OUTWARD) {
        assert.ok(gated.includes(n), `${n} must carry the outward gate`);
    }
    assert.ok(!gated.includes('git_status'), 'git_status must not be gated — the owner kept it on');
    assert.strictEqual(tools.isToolAvailable('git_status'), true);
});

test('none of the five leak into the advertised set by default', () => {
    const tools = loadTools({ bridge: true });
    const advertised = tools.getExecutableToolDefinitions().map((d) => d.name);
    for (const n of OUTWARD) {
        assert.ok(!advertised.includes(n), `${n} must not be advertised without opt-in`);
    }
    assert.ok(advertised.includes('git_status'), 'git_status is advertised as before');
});
