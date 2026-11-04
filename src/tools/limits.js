// Thin CJS shim. The implementation is src/tools/limits.ts (TypeScript, compiled to
// dist/tools/limits.js). It lives at this original path so every existing require() —
// server.js, cli/index.js, src/tools/tools.js, harness_tests/*, bin/webchat.js —
// keeps resolving to the same module it always did.
let compiled;
try {
    compiled = require('../../dist/tools/limits.js');
} catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('/dist/')) {
        process.stderr.write('webchat: the TypeScript build is missing — run `npm run build` first.\n');
    }
    throw error;
}
module.exports = compiled;
