// Thin CJS shim. The implementation is src/tools/mcp-server.ts (TypeScript,
// compiled to dist/tools/mcp-server.js). It lives at this original path because an
// MCP client (and `node src/tools/mcp-server.js --list`) spawns THIS file, so the
// shim is the entry point and must start the stdio server itself.
const mod = require('../../dist/tools/mcp-server.js');
if (require.main === module) mod.main();
else module.exports = mod;
