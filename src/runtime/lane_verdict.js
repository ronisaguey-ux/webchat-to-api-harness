// Thin CJS shim. The implementation is src/runtime/lane_verdict.ts (TypeScript, compiled to
// dist/runtime/lane_verdict.js). It lives at this original path so every existing require() —
// server.js, cli/index.js, src/tools/tools.js, harness_tests/*, bin/webchat.js —
// keeps resolving to the same module it always did.
module.exports = require('../../dist/runtime/lane_verdict.js');
