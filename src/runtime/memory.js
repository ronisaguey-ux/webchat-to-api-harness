// Thin CJS shim. The implementation is src/runtime/memory.ts (TypeScript, compiled to
// dist/runtime/memory.js). It lives at this original path so every existing require() —
// server.js, cli/index.js, src/tools/tools.js, harness_tests/*, bin/webchat.js —
// keeps resolving to the same module it always did.
module.exports = require('../../dist/runtime/memory.js');
