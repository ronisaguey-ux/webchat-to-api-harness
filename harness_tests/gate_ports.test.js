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

test('freePortPair returns ports nothing is listening on', async () => {
    const net = require('net');
    const taken = [];
    for (let i = 0; i < 3; i++) {
        const { cdpPort, gatewayPort } = await G.freePortPair();
        taken.push(cdpPort, gatewayPort);
        // Binding proves the OS handed back a port that was genuinely free.
        for (const p of [cdpPort, gatewayPort]) {
            await new Promise((res, rej) => {
                const s = net.createServer();
                s.on('error', rej);
                s.listen(p, '127.0.0.1', () => s.close(res));
            });
        }
    }
    assert.strictEqual(new Set(taken).size, taken.length, 'a port was handed out twice');
});

test('a gate added with no ports is left for the caller to fill', () => {
    // Ports are picked by the CLI from the OS free list, so add() must not invent a
    // number of its own -- the old fixed bases collided with other stacks on the box.
    G.write({ gates: [], active: null });
    const g = G.add({ site: 'deepseek' });
    assert.strictEqual(g.cdpPort, 0);
    assert.strictEqual(g.gatewayPort, 0);
});

test('an explicit port is never overridden by the default', () => {
    G.write({ gates: [], active: null });
    const g = G.add({ site: 'deepseek', cdpPort: 9333, gatewayPort: 8484 });
    assert.strictEqual(g.cdpPort, 9333);
    assert.strictEqual(g.gatewayPort, 8484);
});

test('two gates never share a port', async () => {
    G.write({ gates: [], active: null });
    const seen = new Set();
    for (const site of ['deepseek', 'chatgpt', 'gemini', 'kimi']) {
        const { cdpPort, gatewayPort } = await G.freePortPair();
        const g = G.add({ site, cdpPort, gatewayPort });
        assert.ok(!seen.has(g.cdpPort), `cdpPort ${g.cdpPort} reused`);
        seen.add(g.cdpPort);
    }
});
