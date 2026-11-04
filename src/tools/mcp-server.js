// Thin CJS shim. The implementation is src/tools/mcp-server.ts (TypeScript,
// compiled to dist/tools/mcp-server.js). It lives at this original path because an
// MCP client (and `node src/tools/mcp-server.js --list`) spawns THIS file, so the
// shim is the entry point and must start the stdio server itself.
let compiled;
try {
    compiled = require('../../dist/tools/mcp-server.js');
} catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('/dist/')) {
        process.stderr.write('webchat: the TypeScript build is missing — run `npm run build` first.\n');
    }
    throw error;
}
if (require.main === module) compiled.main();
else module.exports = compiled;
