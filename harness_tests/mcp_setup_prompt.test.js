'use strict';
//
// The MCP setup prompt, and the tool-count agreement it depends on.
//
// Two things are asserted here and both were real defects before they were asserted:
//
//   1. `mcp-server.js --list` printed "26 tools" while the running server answered
//      tools/list with 43. The extras merge sat BELOW the `--list` block, and `--list`
//      exits - so it read a half-built list. `--list` is the documented way to see the
//      surface, so the wrong number was the one a human saw, and the CLI screen showed
//      the right one. Two displays of one fact, disagreeing.
//
//   2. The setup prompt embeds a JSON config block. On Windows the path must have its
//      separators escaped or `C:\new` becomes a newline and the client's config fails to
//      parse - so the prompt must be generated for the platform the user chose, and the
//      block must actually parse back to the path that was passed in.
//
// Run: node --test harness_tests/mcp_setup_prompt.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const { mcpSetupPrompt, REPO_URL } = require(path.join(REPO, 'cli', 'mcp-setup.js'));

// Extract the embedded config block by balancing braces from the first line that is just
// '{'. A regex is what I got wrong twice by hand - the first '}' it finds is the INNER
// object's, so the slice came out truncated and "invalid JSON" was my extractor, not the
// prompt. Balance instead, and ignore braces inside strings.
function configBlock(text) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim() === '{');
    assert.ok(start >= 0, 'the prompt must contain a config block');
    let depth = 0, end = -1;
    for (let i = start; i < lines.length; i++) {
        let inStr = false;
        for (const ch of lines[i]) {
            if (ch === '"') inStr = !inStr;
            else if (!inStr && ch === '{') depth++;
            else if (!inStr && ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end >= 0) break;
    }
    assert.ok(end > start, 'the config block must be closed');
    return lines.slice(start, end + 1).map((l) => l.replace(/^\s{5}/, '')).join('\n');
}

const LINUX_SERVER = '/home/me/harness/src/tools/mcp-server.js';
const WIN_SERVER = 'C:\\Users\\me\\harness\\src\\tools\\mcp-server.js';

// ── the tool-count agreement ───────────────────────────────────────────────

test('--list reports the same tool count the module and the server do', () => {
    // Before the fix this printed 26 while the server served 43, because the extras merge
    // ran after the --list block and --list exits.
    const listed = execFileSync(process.execPath, [path.join(REPO, 'src', 'tools', 'mcp-server.js'), '--list'], { encoding: 'utf8' });
    const m = /(\d+)\s+tools/.exec(listed);
    assert.ok(m, '--list must state a tool count');
    const listedCount = Number(m[1]);

    const moduleCount = require(path.join(REPO, 'src', 'tools', 'mcp-server.js')).TOOLS.length;
    assert.strictEqual(listedCount, moduleCount,
        `--list says ${listedCount} but the module holds ${moduleCount}: the merge must run before --list reads the list`);

    // And the count of names actually printed must match the count it claims.
    const names = listed.split('\n').filter((l) => l && !/^\s/.test(l)).slice(1);
    assert.strictEqual(names.length, listedCount,
        `--list claims ${listedCount} tools but printed ${names.length} names`);
});

test('the extras merge precedes the --list block in the source', () => {
    // Asserted on the ORDER in the file, because that ordering IS the fix - a later
    // refactor that moves it back would silently re-break the count.
    const src = require('fs').readFileSync(path.join(REPO, 'src', 'tools', 'mcp-server.js'), 'utf8');
    const mergeAt = src.indexOf('for (const t of EXTRA)');
    const listAt = src.indexOf("process.argv.includes('--list')");
    assert.ok(mergeAt > 0, 'the extras merge must exist');
    assert.ok(listAt > 0, 'the --list block must exist');
    assert.ok(mergeAt < listAt,
        'the extras merge must come BEFORE --list, or --list reports a partial list (it was 26 of 43)');
});

// ── the prompt: platform awareness ─────────────────────────────────────────

test('a linux prompt uses bash and forward slashes, and leaves the path alone', () => {
    const t = mcpSetupPrompt({ platform: 'linux', serverPath: LINUX_SERVER, toolCount: 43 });
    assert.match(t, /shell is bash/);
    assert.match(t, /forward slashes/);
    const cfg = JSON.parse(configBlock(t));
    assert.strictEqual(cfg.mcpServers['webchat-harness'].args[0], LINUX_SERVER);
    assert.strictEqual(cfg.mcpServers['webchat-harness'].command, 'node');
});

test('a windows prompt escapes separators so the JSON parses back to the real path', () => {
    const t = mcpSetupPrompt({ platform: 'windows', serverPath: WIN_SERVER, toolCount: 43 });
    assert.match(t, /shell is cmd\.exe/);
    assert.match(t, /backslashes/);
    // The embedded block must carry the path JSON-ESCAPED, so `C:\n` cannot become a
    // newline. Computed rather than hand-written: a hand-escaped regex is easy to
    // over-escape, and an over-escaped one FAILS on correct output - which is exactly what
    // my first version of this assertion did, blaming the code for my own mistake.
    const escaped = WIN_SERVER.replace(/\\/g, '\\\\');
    assert.ok(t.includes(escaped), `the path must appear escaped (${escaped})`);
    // ... and must round-trip to exactly the path that was passed in.
    const cfg = JSON.parse(configBlock(t));
    assert.strictEqual(cfg.mcpServers['webchat-harness'].args[0], WIN_SERVER,
        'escaping must survive a parse: C:\\n would otherwise become a newline');
});

test('the prompt carries the repo, the tool count and the entry point', () => {
    const t = mcpSetupPrompt({ platform: 'linux', serverPath: LINUX_SERVER, toolCount: 43 });
    assert.ok(t.includes(REPO_URL), 'the repo URL must be in the prompt');
    assert.match(t, /43/, 'the tool count must be stated');
    assert.match(t, /mcp-server\.js/, 'the MCP entry point must be named');
    assert.match(t, /node --version|node -v/, 'the node version check must be included');
});

test('the prompt tells the agent to FIND the client config, not to use an invented path', () => {
    // We cannot know the client's config path - it varies by client and version, and the
    // agent may be on another machine entirely. A fabricated path is a setup that fails
    // silently, so the prompt must instruct the agent to locate it.
    const t = mcpSetupPrompt({ platform: 'linux', serverPath: LINUX_SERVER, toolCount: 43 });
    assert.match(t, /do not guess it/i, 'the prompt must forbid guessing the config path');
    assert.match(t, /Common locations, but confirm against your own docs/);
    // It may name conventional locations as hints, but must not claim one is authoritative.
    assert.ok(!/your config file is (at )?~\/\./i.test(t), 'it must not assert a specific config path as fact');
});

test('the prompt carries the stdout-is-the-wire rule', () => {
    // The single most important constraint of this server: a stray print corrupts the
    // protocol stream and reads to the client as the server being broken.
    const t = mcpSetupPrompt({ platform: 'linux', serverPath: LINUX_SERVER, toolCount: 43 });
    assert.match(t, /STDOUT IS THE WIRE/);
    assert.match(t, /stderr/);
});

test('the prompt defaults safely when it is given nothing', () => {
    // A caller that forgets an option must still get a usable, non-lying prompt rather
    // than "undefined" written into a config the user will paste.
    const t = mcpSetupPrompt();
    assert.ok(!/undefined/.test(t), 'no option may render as "undefined"');
    assert.ok(!/NaN/.test(t), 'no option may render as "NaN"');
    assert.match(t, /shell is bash/, 'it must fall back to a platform rather than failing');
    assert.doesNotThrow(() => JSON.parse(configBlock(t)));
});

test('an unknown platform falls back to linux rather than rendering nonsense', () => {
    const t = mcpSetupPrompt({ platform: 'solaris', serverPath: LINUX_SERVER, toolCount: 43 });
    assert.match(t, /shell is bash/);
    assert.ok(!/solaris/.test(t));
});
