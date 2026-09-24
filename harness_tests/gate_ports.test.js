'use strict';
//
// A gate with no ports is unusable: every later step reads CDP :0 and reports
// "browser not answering" while the browser is open and logged in. The CLI's
// add-gate screen passes ports explicitly, but the MCP tool (webchat_gate_add)
// did not, so an AGENT-created gate was born dead.
//
// Run: node --test harness_tests/gate_ports.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
process.env.WEBCHAT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-gateports-'));

const G = require(path.join(REPO, 'cli', 'gates.js'));

test('a gate added with no ports still gets usable ones', () => {
    const g = G.add({ site: 'deepseek' });
    assert.ok(g.cdpPort > 0, `cdpPort must be allocated, got ${g.cdpPort}`);
    assert.ok(g.gatewayPort > 0, `gatewayPort must be allocated, got ${g.gatewayPort}`);
});

test('the allocated pair matches what the CLI screen computes', () => {
    G.write({ gates: [], active: null });
    const first = G.add({ site: 'deepseek' });
    assert.strictEqual(first.cdpPort, 9225, 'first gate -> 9225');
    assert.strictEqual(first.gatewayPort, 8081, 'first gate -> 8081');
    const second = G.add({ site: 'chatgpt' });
    assert.strictEqual(second.cdpPort, 9226, 'second gate -> 9226');
    assert.strictEqual(second.gatewayPort, 8082, 'second gate -> 8082');
});

test('an explicit port is never overridden by the default', () => {
    G.write({ gates: [], active: null });
    const g = G.add({ site: 'deepseek', cdpPort: 9333, gatewayPort: 8484 });
    assert.strictEqual(g.cdpPort, 9333);
    assert.strictEqual(g.gatewayPort, 8484);
});

test('two gates never share a port', () => {
    G.write({ gates: [], active: null });
    const seen = new Set();
    for (const site of ['deepseek', 'chatgpt', 'gemini', 'kimi']) {
        const g = G.add({ site });
        assert.ok(!seen.has(g.cdpPort), `cdpPort ${g.cdpPort} reused`);
        seen.add(g.cdpPort);
    }
});
