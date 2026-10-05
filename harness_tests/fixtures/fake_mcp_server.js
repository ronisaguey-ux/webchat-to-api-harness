#!/usr/bin/env node
// A REAL MCP server over stdio, used by harness_tests/mcp_live_sync.test.js.
//
// It lives in the repo on purpose: the test previously pointed at
// /tmp/opencode/fake_mcp_server.js, which nothing created or tracked, so the four
// live-sync tests failed on every clean checkout with no file to talk to.
//
// Minimal hand-rolled JSON-RPC over stdio - no SDK, so a dependency cannot break it:
//   initialize -> tools/list -> tools/call
'use strict';
const readline = require('readline');

const TOOLS = [
  { name: 'fake_echo', description: 'echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fake_ping', description: 'return pong',
    inputSchema: { type: 'object', properties: {} } },
];

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // no reply to a notification
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'fake_echo') {
      return reply(id, { content: [{ type: 'text', text: String(args.text) }] });
    }
    if (name === 'fake_ping') {
      return reply(id, { content: [{ type: 'text', text: 'pong' }] });
    }
    return fail(id, -32602, 'unknown tool: ' + name);
  }
  if (id !== undefined) fail(id, -32601, 'method not found: ' + method);
});
