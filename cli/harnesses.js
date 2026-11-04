// Thin CJS shim. The implementation is src/cli/harnesses.ts (TypeScript, compiled to
// dist/cli/harnesses.js). It lives at this original path so every existing require() —
// server.js, cli/index.js, src/tools/tools.js, harness_tests/*, bin/webchat.js —
// keeps resolving to the same module it always did.
module.exports = require('../dist/cli/harnesses.js');
