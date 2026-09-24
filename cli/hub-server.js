'use strict';
//
// hub-server.js — the process that serves the single base url.
//
// Started by `webchat connect` (cli/daemon.js) on a free port, reading the same
// .webchat/gates.json the CLI writes, so the routing table is whatever the user has
// connected rather than a second source of truth.
//
//   HUB_PORT  required — the port to listen on
//   HUB_HOST  optional — defaults to 127.0.0.1 (local only, never exposed)

const G = require('./gates.js');
const models = require('../src/models/webchat-models.js');
const { createHub } = require('./hub.js');

const port = Number(process.env.HUB_PORT);
if (!port) {
    console.error('hub: HUB_PORT is required');
    process.exit(2);
}

const hub = createHub({
    readGates: () => {
        try { return G.read().gates || []; } catch { return []; }
    },
    models,
    log: (m) => { if (process.env.HUB_QUIET !== '1') console.log(`[hub] ${m}`); },
});

hub.listen(port, process.env.HUB_HOST || '127.0.0.1', () => {
    console.log(`[hub] one url for every webchat: http://127.0.0.1:${port}/v1`);
});

// A hub that dies silently leaves the harness pointed at a dead url, which reads as
// "the webchat broke". Say why instead.
process.on('uncaughtException', (e) => {
    console.error(`[hub] fatal: ${e.message}`);
    process.exit(1);
});
