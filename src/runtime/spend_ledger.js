// Thin CJS shim. The implementation is src/runtime/spend_ledger.ts (TypeScript, compiled to
// dist/runtime/spend_ledger.js). It lives at this original path so every existing require() —
// server.js, cli/index.js, src/tools/tools.js, harness_tests/*, bin/webchat.js —
// keeps resolving to the same module it always did.
module.exports = require('../../dist/runtime/spend_ledger.js');
