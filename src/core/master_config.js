// Thin CJS shim. The implementation is src/core/master_config.ts (TypeScript, compiled to
// dist/core/master_config.js). It lives at this original path so every existing require() —
// server.js, cli/index.js, src/tools/tools.js, harness_tests/*, bin/webchat.js —
// keeps resolving to the same module it always did.
module.exports = require('../../dist/core/master_config.js');
