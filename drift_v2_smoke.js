'use strict';
const assert = require('assert');
const { MultiSignalGatewayGate } = require('./drift_v2');
(async () => {
    const g = new MultiSignalGatewayGate({ mode: 2, escalationCount: 2, judgeFn: async () => ({ drifted: true, reason: 'x' }) });
    const r1 = await g.feed('normal work reasoning', 'task');
    assert.strictEqual(r1.paused, false, 'benign must not pause');
    console.log('drift_v2 smoke OK mode=' + g.mode);
})().catch((e) => { console.error(e); process.exit(1); });
