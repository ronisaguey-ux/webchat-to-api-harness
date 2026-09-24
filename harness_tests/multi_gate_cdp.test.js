'use strict';
//
// Several webchats at once, and the one thing that silently breaks it: a gateway
// attaching to the WRONG gate's browser. That failure produces no error — the
// gateway works, it just answers as the other account.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-cdp-'));
process.env.HARNESS_CONFIG = path.join(TMP, 'harness.config.json');
fs.writeFileSync(process.env.HARNESS_CONFIG, '{}');

// cdpPort() reads process.env.CDP_PORT at CALL time, not at require time, so the env
// must still be set when the order is read — restoring it too early silently falls
// back to 9225 and the test passes for the wrong reason.
function withBrowser(env, fn) {
    const saved = process.env.CDP_PORT;
    if (env === undefined) delete process.env.CDP_PORT; else process.env.CDP_PORT = env;
    for (const k of Object.keys(require.cache)) {
        if (/(browser|config|master_config)\.js$/.test(k)) delete require.cache[k];
    }
    try {
        return fn(require(path.join(__dirname, '..', 'browser.js')));
    } finally {
        if (saved === undefined) delete process.env.CDP_PORT; else process.env.CDP_PORT = saved;
    }
}

test('a gateway configured for its own gate probes THAT port first', () => {
    // Gate #2 lives on 9226. The conventional list starts at 9225, which is gate #1.
    withBrowser('9226', (b) => {
        const order = b.cdpProbeOrder();
        assert.strictEqual(order[0], 9226, 'the configured port must be tried before any conventional port');
        assert.ok(order.indexOf(9225) > 0, '9225 is still reachable, but only as a fallback');
    });
});

test('with no gate configured the classic 9225 is still first', () => {
    withBrowser(undefined, (b) => {
        assert.strictEqual(b.cdpProbeOrder()[0], 9225, 'cold start must behave exactly as before');
    });
});

test('every port the CLI hands to an extra gate is probeable', () => {
    // cli/gates.js assigns 9225 + n, so gate #5 is 9229. A port we launch on but do
    // not probe is unreachable — launch and probe must agree.
    withBrowser(undefined, (b) => {
        const order = b.cdpProbeOrder();
        for (const p of [9226, 9227, 9228, 9229, 9230]) {
            assert.ok(order.includes(p), `gate port ${p} is never probed, so that gate can never attach`);
        }
    });
});

test('the probe order has no duplicates', () => {
    withBrowser('9226', (b) => {
        const order = b.cdpProbeOrder();
        assert.strictEqual(new Set(order).size, order.length, 'a duplicated port wastes a probe and hides a typo');
    });
});
