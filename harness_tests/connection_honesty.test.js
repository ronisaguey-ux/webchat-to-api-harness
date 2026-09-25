'use strict';
//
// The CLI reported a webchat as "connected" after its browser had been closed.
//
// Two separate defects produced it, and both are the same class — a claim made without
// evidence:
//
//   1. The dashboard header read `connected.json` — a file written when the user confirms
//      a tab, and which NOTHING ever clears (clearConnection is defined and never called).
//      The Webchats list has always re-verified live via G.refresh(); the header did not,
//      so the two contradicted each other on the same screen.
//
//   2. connected.json had THREE different shapes from three call sites, only one of which
//      named a gate. A reader trusting the array shape saw "nothing connected" after a real
//      connect — the same dishonesty inverted.
//
// Run: node --test harness_tests/connection_honesty.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

// A fresh state dir per process, so nothing here can touch the live ~/.webchat state.
// (A previous test in this repo wrote a fake gateway port into the REAL agent dir by
// calling the path helper directly. Never again.)
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'connstate-'));
process.env.WEBCHAT_STATE_DIR = STATE;

const D = require(path.join(REPO, 'cli', 'daemon.js'));

test('the connected badge needs PROVEN liveness, never a recorded file', () => {
    const idx = require(path.join(REPO, 'cli', 'index.js'));
    // The bug, exactly: a recorded connection whose browser is gone.
    assert.strictEqual(idx.connectionBadge({ gates: [{ id: 'deepseek' }], live: false }), null,
        'a recorded but dead connection must not read as connected');
    assert.strictEqual(idx.connectionBadge({ gates: [{ id: 'deepseek' }] }), null,
        'no `live` flag at all is not evidence of anything');
    assert.strictEqual(idx.connectionBadge(null), null, 'nothing recorded, nothing claimed');
    assert.strictEqual(idx.connectionBadge(undefined), null);
    assert.strictEqual(idx.connectionBadge({ live: true }), 'connected',
        'and a proven-live connection is reported');
});

// ── the three on-disk shapes ─────────────────────────────────────────────────
test('normalizeConnection accepts all three shapes connected.json has been written in', () => {
    const current = { gates: [{ id: 'deepseek', gatewayPort: 8081, cdpPort: 9225 }], agent: 'opencode' };
    const singular = { gate: 'deepseek', mode: 'deepseek', cdpPort: 9225, gatewayPort: 8081 };
    const oldest = { mode: 'deepseek', cdpPort: 9225, cdpWsUrl: 'ws://127.0.0.1:9225/x' };

    assert.deepStrictEqual(D.normalizeConnection(current).gates, current.gates,
        'the current shape passes through untouched');
    assert.deepStrictEqual(D.normalizeConnection(singular).gates,
        [{ id: 'deepseek', gatewayPort: 8081, cdpPort: 9225 }],
        'the singular `gate` key becomes the gates array');
    assert.deepStrictEqual(D.normalizeConnection(oldest).gates, [{ id: null, cdpPort: 9225 }],
        'the oldest shape named no gate: keep the port and admit the id is unknown');
    assert.deepStrictEqual(D.normalizeConnection({}).gates, []);
    assert.strictEqual(D.normalizeConnection(null), null);
});

test('readConnection normalises what is on disk, so no consumer sees a shape it cannot read', () => {
    // Write the shape that used to make a connected webchat look unconfigured.
    fs.writeFileSync(path.join(STATE, 'connected.json'),
        JSON.stringify({ gate: 'deepseek', mode: 'deepseek', cdpPort: 9225, gatewayPort: 8081 }));

    const got = D.readConnection();
    assert.ok(got, 'a legacy file must still read as a connection');
    assert.ok(Array.isArray(got.gates) && got.gates.length === 1,
        'a reader expecting an array must find one — this is the false "nothing connected"');
    assert.strictEqual(got.gates[0].id, 'deepseek', 'and it must name the gate');
});

test('a connection file naming no gate keeps a port a caller can match on', () => {
    fs.writeFileSync(path.join(STATE, 'connected.json'),
        JSON.stringify({ mode: 'deepseek', cdpPort: 9225 }));
    const got = D.readConnection();
    assert.strictEqual(got.gates[0].id, null, 'the id is genuinely unknown and is not invented');
    assert.strictEqual(got.gates[0].cdpPort, 9225,
        'but the port survives, so the registry can still be matched by port');
});

test('a corrupt or missing file is null, never a crash and never a claim', () => {
    fs.writeFileSync(path.join(STATE, 'connected.json'), '{not json');
    assert.strictEqual(D.readConnection(), null);
    fs.unlinkSync(path.join(STATE, 'connected.json'));
    assert.strictEqual(D.readConnection(), null);
});

// ── the duplicate module.exports ─────────────────────────────────────────────
//
// cli/index.js ended with TWO top-level `module.exports = {...}` assignments. The second
// silently replaced the first, so screenDashboard / cmdStart / screenDoctor were exported
// as undefined. Nothing imported them yet, which is why it never showed up as a failure —
// it would have been a confusing undefined the first time anyone tried.
test('cli/index.js exports everything it declares, with no assignment overwriting another', () => {
    const src = fs.readFileSync(path.join(REPO, 'cli', 'index.js'), 'utf8');
    const count = (src.match(/^module\.exports\s*=/gm) || []).length;
    assert.strictEqual(count, 1, 'a second module.exports silently discards the first');
});
