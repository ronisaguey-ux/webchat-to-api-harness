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
    assert.strictEqual(first.cdpPort, G.CDP_PORT_BASE, 'first gate -> CDP base');
    assert.strictEqual(first.gatewayPort, G.GATEWAY_PORT_BASE, 'first gate -> gateway base');
    const second = G.add({ site: 'chatgpt' });
    assert.strictEqual(second.cdpPort, G.CDP_PORT_BASE + 1);
    assert.strictEqual(second.gatewayPort, G.GATEWAY_PORT_BASE + 1);
});

test('the harness range does not collide with the rest of this machine', () => {
    // 8081-8083 are oculus gateway units and 9225-9230 their chromes. Allocating the
    // harness inside those ranges made `webchat connect` report a healthy gateway that
    // was really another stack's lane.
    assert.ok(G.GATEWAY_PORT_BASE >= 8181, `gateway base ${G.GATEWAY_PORT_BASE} is in the occupied range`);
    assert.ok(G.CDP_PORT_BASE >= 9281, `cdp base ${G.CDP_PORT_BASE} is in the occupied range`);
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
