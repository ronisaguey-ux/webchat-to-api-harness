// Thin CJS shim. The implementation is src/runtime/compactor.ts (TypeScript, compiled to
// dist/runtime/compactor.js). It lives at this original path so every existing require() —
// server.js, cli/index.js, src/tools/tools.js, harness_tests/*, bin/webchat.js —
// keeps resolving to the same module it always did.
module.exports = require('../../dist/runtime/compactor.js');
