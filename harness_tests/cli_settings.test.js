'use strict';
// Settings-layer tests (2026-09-22).
//
// These exist because the settings layer holds three pieces of logic that are
// easy to get wrong and SILENT when wrong:
//
//   1. WHICH config file. A working install has two — the template inside the
//      clone and the real one outside it, named by HARNESS_CONFIG in
//      harness/.env. Editing the wrong one looks like the CLI does nothing.
//   2. PRECEDENCE. dotenv loads harness/.env at boot, so a line there becomes a
//      process.env entry and OUTRANKS harness.config.json. On this install that
//      is not hypothetical: WEBCHAT_MODE lives in .env.
//   3. ATOMICITY. The harness reads its config once at boot, so a truncated
//      write reverts every setting to default with no error anywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../cli/settings.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-settings-'));
const write = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };

// ── .env parsing ───────────────────────────────────────────────────────────

test('parseEnvFile reads plain, quoted and exported lines and skips comments', () => {
    const vars = S.parseEnvFile([
        '# a comment',
        'PLAIN=value',
        'SPACED = value with spaces ',
        'QUOTED="quoted value"',
        "SINGLE='single value'",
        'export EXPORTED=yes',
        '',
        'NOEQUALS',
    ].join('\n'));
    assert.strictEqual(vars.PLAIN, 'value');
    assert.strictEqual(vars.SPACED, 'value with spaces');
    assert.strictEqual(vars.QUOTED, 'quoted value');
    assert.strictEqual(vars.SINGLE, 'single value');
    assert.strictEqual(vars.EXPORTED, 'yes');
    assert.strictEqual(vars.NOEQUALS, undefined);
    assert.strictEqual(vars['# a comment'], undefined);
});

test('setEnvVar replaces in place and appends when absent, preserving comments', () => {
    const before = '# keep me\nA=1\nB=old\n\n# trailing comment\n';
    const replaced = S.setEnvVar(before, 'B', 'new');
    assert.match(replaced, /# keep me/);
    assert.match(replaced, /^B=new$/m);
    assert.match(replaced, /# trailing comment/);
    assert.strictEqual((replaced.match(/^B=/gm) || []).length, 1, 'must not duplicate the key');

    const appended = S.setEnvVar(before, 'C', '3');
    assert.match(appended, /^C=3$/m);
    assert.match(appended, /^A=1$/m);
});

test('removeEnvVar drops only the named key', () => {
    const before = 'A=1\nexport B=2\nC=3\n';
    const after = S.removeEnvVar(before, 'B');
    assert.doesNotMatch(after, /B=2/);
    assert.match(after, /^A=1$/m);
    assert.match(after, /^C=3$/m);
});

// ── dotted paths ───────────────────────────────────────────────────────────

test('getPath/setPath round-trip a nested key and delete on undefined', () => {
    const o = {};
    S.setPath(o, 'features.bashAllowed', true);
    assert.strictEqual(S.getPath(o, 'features.bashAllowed'), true);
    S.setPath(o, 'features.bashAllowed', undefined);
    assert.strictEqual(S.getPath(o, 'features.bashAllowed'), undefined);
    assert.deepStrictEqual(o.features, {}, 'delete leaves the parent intact');
});

// ── coercion ───────────────────────────────────────────────────────────────

test('coerce maps each schema type', () => {
    assert.strictEqual(S.coerce({ type: 'bool' }, 'true'), true);
    assert.strictEqual(S.coerce({ type: 'bool' }, 'false'), false);
    assert.strictEqual(S.coerce({ type: 'bool' }, true), true);
    assert.strictEqual(S.coerce({ type: 'number' }, '42'), 42);
    assert.strictEqual(S.coerce({ type: 'number' }, 'nope'), undefined);
    assert.deepStrictEqual(S.coerce({ type: 'list' }, 'a, b ,c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(S.coerce({ type: 'list' }, ['x', 'y']), ['x', 'y']);
    assert.strictEqual(S.coerce({ type: 'string' }, 7), '7');
});

// ── precedence: this is the load-bearing one ───────────────────────────────

test('resolve prefers a real env var, then .env, then the file, then default', () => {
    const raw = { features: { narration: false } };
    const setting = { path: 'features.narration', type: 'bool', env: 'NARRATION' };

    // nothing anywhere
    assert.strictEqual(S.resolve(setting, {}, {}, {}).source, 'default');

    // only the file
    const fileOnly = S.resolve(setting, raw, {}, {});
    assert.strictEqual(fileOnly.source, 'file');
    assert.strictEqual(fileOnly.value, false);

    // .env beats the file — the case that makes an edit silently do nothing
    const dotenvWins = S.resolve(setting, raw, {}, { NARRATION: 'true' });
    assert.strictEqual(dotenvWins.source, 'env');
    assert.strictEqual(dotenvWins.value, true);
    assert.strictEqual(dotenvWins.envWhere, 'harness/.env');
    assert.strictEqual(dotenvWins.shadowedBy, 'NARRATION');
    assert.strictEqual(dotenvWins.shadowedFileValue, false,
        'the file value must still be reported so the UI can show what an unshadow would restore');

    // the real environment beats .env
    const processWins = S.resolve(setting, raw, { NARRATION: 'false' }, { NARRATION: 'true' });
    assert.strictEqual(processWins.value, false);
    assert.strictEqual(processWins.envWhere, 'environment');
});

test('resolve reports an env-only setting as unset rather than inventing a value', () => {
    const setting = { path: '__env__.API_TOKEN', type: 'secret', env: 'API_TOKEN', envOnly: true };
    assert.strictEqual(S.resolve(setting, {}, {}, {}).source, 'unset');
    assert.strictEqual(S.resolve(setting, {}, {}, { API_TOKEN: 'tok' }).value, 'tok');
});

test('resolve inverts SANDBOX_LOG, which means "log unless explicitly false"', () => {
    const setting = { path: '__env__.SANDBOX_LOG', type: 'envbool', env: 'SANDBOX_LOG' };
    assert.strictEqual(S.resolve(setting, {}, {}, {}).value, true, 'unset keeps logging on');
    assert.strictEqual(S.resolve(setting, {}, {}, { SANDBOX_LOG: 'false' }).value, false);
    assert.strictEqual(S.resolve(setting, {}, {}, { SANDBOX_LOG: 'true' }).value, true);
});

// ── the two-file trap ──────────────────────────────────────────────────────

test('configFilePath honours an explicit path, then HARNESS_CONFIG, then .env', () => {
    const explicit = write('explicit.json', '{}');
    assert.strictEqual(S.configFilePath(explicit), explicit);

    const viaEnv = write('via-env.json', '{}');
    const savedCfg = process.env.HARNESS_CONFIG;
    const savedEnvFile = process.env.ENV_FILE;
    try {
        process.env.HARNESS_CONFIG = viaEnv;
        assert.strictEqual(S.configFilePath(), viaEnv);

        // No real env var: fall through to HARNESS_CONFIG inside .env, which is
        // how the harness itself resolves it. Missing this is the bug this test
        // exists for — the CLI would edit the in-clone template instead.
        delete process.env.HARNESS_CONFIG;
        const viaDotenv = write('via-dotenv.json', '{}');
        const envFile = write('harness.env', `HARNESS_CONFIG=${viaDotenv}\n`);
        process.env.ENV_FILE = envFile;
        assert.strictEqual(S.configFilePath(), viaDotenv);
    } finally {
        if (savedCfg === undefined) delete process.env.HARNESS_CONFIG; else process.env.HARNESS_CONFIG = savedCfg;
        if (savedEnvFile === undefined) delete process.env.ENV_FILE; else process.env.ENV_FILE = savedEnvFile;
    }
});

test('loadRaw falls back to an empty object on malformed JSON instead of throwing', () => {
    const bad = write('bad.json', '{ not json');
    const res = S.loadRaw(bad);
    assert.deepStrictEqual(res.raw, {});
    assert.ok(res.error, 'the parse error is reported, not swallowed');
});

// ── atomic writes ──────────────────────────────────────────────────────────

test('saveRaw writes valid JSON, backs up the previous file, and leaves no temp file', () => {
    const file = path.join(tmp, 'roundtrip.json');
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));

    S.saveRaw({ a: 2, b: { c: 3 } }, file);

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepStrictEqual(parsed, { a: 2, b: { c: 3 } });

    const backups = fs.readdirSync(tmp).filter((f) => f.includes('roundtrip.json.bak-'));
    assert.strictEqual(backups.length, 1, 'exactly one backup of the previous contents');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tmp, backups[0]), 'utf-8')), { a: 1 });

    const temps = fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'));
    assert.deepStrictEqual(temps, [], 'the temp file is renamed, never left behind');
});

// ── schema integrity ───────────────────────────────────────────────────────

test('the schema is coherent: unique paths, every group titled, every type known', () => {
    const TYPES = new Set(['bool', 'number', 'string', 'list', 'enum', 'secret', 'longtext', 'envbool', 'mode', 'choice']);
    const seen = new Set();
    for (const g of S.SCHEMA) {
        assert.ok(g.id && g.title && g.blurb, `group ${g.id} needs id/title/blurb`);
        for (const s of g.settings) {
            assert.ok(!seen.has(s.path), `duplicate path ${s.path}`);
            seen.add(s.path);
            assert.ok(TYPES.has(s.type), `unknown type "${s.type}" on ${s.path}`);
            assert.ok(s.label, `${s.path} needs a label`);
            if (s.validate) assert.strictEqual(typeof s.validate, 'function');
        }
    }
    assert.ok(seen.size >= 40, `expected the full surface, got ${seen.size}`);
});

test('display renders booleans, lists, secrets and empties readably', () => {
    assert.strictEqual(S.display({ type: 'bool' }, true), 'on');
    assert.strictEqual(S.display({ type: 'bool' }, false), 'off');
    assert.strictEqual(S.display({ type: 'list' }, ['a', 'b']), 'a, b');
    assert.strictEqual(S.display({ type: 'list' }, []), '(none)');
    assert.strictEqual(S.display({ type: 'string' }, ''), '(not set)');
    assert.strictEqual(S.display({ type: 'secret' }, 'hunter2'), '••••••••');
});

test('listModes reports every configured webchat with its selectors and quirks', () => {
    const raw = {
        webchatModes: {
            gemini: { url: 'https://gemini.google.com', selectors: { input: 'x' }, quirks: { phantomStopButton: true }, threadPattern: '/app/[0-9a-f]+' },
            generic: {},
        },
    };
    const modes = S.listModes(raw);
    assert.deepStrictEqual(modes.map((m) => m.id), ['gemini', 'generic']);
    assert.strictEqual(modes[0].quirks.phantomStopButton, true);
    assert.strictEqual(modes[1].url, '');
});
