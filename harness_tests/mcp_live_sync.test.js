// 09-26 (owner): "some of those require external mcps so they shouldnt even be
// present unless the user has the mcps for it, and any new mcps added should
// automatically show up".
//
// MCP tools were already discovered dynamically — the gap was WHEN. Discovery ran
// once and latched for the life of the process, so an MCP added to the config while
// the gateway was running did not exist until a restart. These tests drive the real
// stdio transport against a real (fake, but real-protocol) MCP server, because a
// stubbed pool would prove nothing about whether the handshake and listing work.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { McpPool } = require('../src/tools/mcp.js');

// The fixture lives IN THE REPO. It used to point at /tmp/opencode/..., which no
// checkout ever created, so these four tests failed everywhere except the one
// machine that had the file by accident.
const FAKE = require('path').join(__dirname, 'fixtures', 'fake_mcp_server.js');
const spec = () => ({ name: 'fake', command: 'node', args: [FAKE] });

const names = (pool) => pool.externalDefinitions().map((d) => d.name).sort();

test('the pool starts empty and advertises nothing', () => {
    const pool = new McpPool([]);
    assert.strictEqual(pool.configured, 0);
    assert.deepStrictEqual(names(pool), []);
});

test('a server added by sync is discovered and its tools advertised', async (t) => {
    const pool = new McpPool([]);
    t.after(() => pool.closeAll());
    const changes = await pool.sync([spec()]);
    assert.strictEqual(changes, 1, 'sync must report the set moved');
    assert.deepStrictEqual(names(pool), ['fake.fake_echo', 'fake.fake_ping']);
    assert.ok(pool.has('fake.fake_ping'));
});

test('sync is idempotent — re-handing the same config adds nothing', async (t) => {
    const pool = new McpPool([spec()]);
    t.after(() => pool.closeAll());
    await pool.discover();
    const before = names(pool);
    const changes = await pool.sync([spec()]);
    assert.strictEqual(changes, 0, 'nothing changed, so nothing is re-listed');
    assert.deepStrictEqual(names(pool), before);
});

test('a discovered MCP tool is actually callable through the pool', async (t) => {
    const pool = new McpPool([spec()]);
    t.after(() => pool.closeAll());
    await pool.discover();
    const res = await pool.execute('fake.fake_echo', { text: 'sync-ok' });
    assert.ok(!res.error, `execute failed: ${res.error}`);
    assert.match(JSON.stringify(res), /sync-ok/);
});

test('a server removed from the config stops being advertised', async (t) => {
    const pool = new McpPool([spec()]);
    t.after(() => pool.closeAll());
    await pool.discover();
    assert.ok(names(pool).length > 0, 'precondition: tools are advertised');

    const changes = await pool.sync([]);
    assert.strictEqual(changes, 1, 'removal must be reported');
    assert.deepStrictEqual(names(pool), [], 'its tools must be gone from the advertised set');
    assert.strictEqual(pool.has('fake.fake_ping'), false, 'and unroutable');
    assert.strictEqual(pool.configured, 0);
});

test('a removed tool cannot be executed any more', async (t) => {
    const pool = new McpPool([spec()]);
    t.after(() => pool.closeAll());
    await pool.discover();
    await pool.sync([]);
    const res = await pool.execute('fake.fake_ping', {});
    assert.strictEqual(res.success, false);
    assert.match(String(res.error), /unknown MCP tool/);
});
