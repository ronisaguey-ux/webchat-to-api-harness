'use strict';
// A settings reader must report the CONFIGURED value, never a default that merely looks plausible.
//
// Two related defects, both measured on this box, where the config says platform "windows":
//
//   1. resolveAll(raw, ...) took `raw` with NO DEFAULT, so calling resolveAll() resolved against
//      `undefined` and every file-backed setting fell through to its default. Its own comment
//      said "only omitting the argument loads the file" — the signature did the opposite.
//      Measured: platform reported "linux" (source default) while the config said "windows",
//      and file-backed settings resolved 45 -> 17 without raw. Eight callers passed raw and
//      worked; the one that omitted it was silently wrong.
//   2. resolveAll() returns an ARRAY, so reading `.platform` off it is always undefined — and an
//      `|| 'linux'` behind it turns the mistake into a wrong answer instead of an error. Fixed
//      at the platform screen once and left in the MCP setup prompt, so a Windows user was
//      handed a Linux briefing with POSIX paths.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

// Load the CLI modules against a scratch config/.env, so nothing here reads live state.
function withScratchConfig(config, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-platform-'));
    const cfg = path.join(dir, 'harness.config.json');
    fs.writeFileSync(cfg, JSON.stringify(config, null, 2));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, '');
    const saved = { cfg: process.env.HARNESS_CONFIG, env: process.env.ENV_FILE };
    process.env.HARNESS_CONFIG = cfg;
    process.env.ENV_FILE = envFile;
    const clear = () => {
        for (const m of ['cli/index.js', 'cli/settings.js']) {
            try { delete require.cache[require.resolve(path.join(REPO, m))]; } catch {}
        }
    };
    clear();
    try { return fn(dir); } finally {
        if (saved.cfg === undefined) delete process.env.HARNESS_CONFIG; else process.env.HARNESS_CONFIG = saved.cfg;
        if (saved.env === undefined) delete process.env.ENV_FILE; else process.env.ENV_FILE = saved.env;
        clear();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
}

test('resolveAll() with no arguments reads the CONFIG FILE, not the defaults', () => {
    withScratchConfig({ platform: 'windows', webchat: { mode: 'deepseek' } }, () => {
        const S = require(path.join(REPO, 'cli/settings.js'));
        const row = S.resolveAll().find((r) => r.setting.path === 'platform');
        assert.strictEqual(row.value, 'windows',
            'omitting raw must load the file — the comment promised it and the code did not');
        assert.strictEqual(row.source, 'file', 'the value came from the file, and says so');
    });
});

test('an explicit fixture is still honoured and does not read the real file', () => {
    withScratchConfig({ platform: 'windows' }, () => {
        const S = require(path.join(REPO, 'cli/settings.js'));
        const fixture = S.resolveAll({ platform: 'linux' });
        assert.strictEqual(fixture.find((r) => r.setting.path === 'platform').value, 'linux',
            'a caller passing a fixture must get the fixture');
        // An EMPTY fixture must mean "nothing configured", not "go and read the real file".
        const empty = S.resolveAll({});
        assert.strictEqual(empty.find((r) => r.setting.path === 'platform').source, 'default',
            'an explicit empty object must not silently fall back to the on-disk config');
    });
});

test('currentPlatform() reports the configured platform', () => {
    withScratchConfig({ platform: 'windows' }, () => {
        const idx = require(path.join(REPO, 'cli/index.js'));
        assert.strictEqual(typeof idx.currentPlatform, 'function',
            'currentPlatform must be exported so the rule is testable');
        assert.strictEqual(idx.currentPlatform(), 'windows',
            'a configured platform=windows must be reported, not replaced with linux');
    });
});

test('no source file reads a property directly off resolveAll()', () => {
    // The class guard. resolveAll() has only ever returned an array; every `resolveAll().x`
    // has been undefined by construction.
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith('.js')) continue;
            const src = fs.readFileSync(p, 'utf8');
            // Skip the DEFINITION line: `function resolveAll(raw = loadRaw().raw, ...)` contains
            // `resolveAll(` followed by a `)` and then `.raw`, which is not a call site.
            const callSites = src.split('\n')
                .filter((l) => !/function\s+resolveAll\s*\(/.test(l))
                .join('\n');
            const re = /resolveAll\([^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)/g;
            let m;
            while ((m = re.exec(callSites))) {
                const arrayMethods = ['find', 'filter', 'map', 'some', 'every', 'forEach',
                    'reduce', 'length', 'indexOf', 'slice', 'sort', 'includes', 'join'];
                if (arrayMethods.includes(m[1])) continue;
                offenders.push(`${path.relative(REPO, p)}: ${m[0]}`);
            }
        }
    };
    walk(path.join(REPO, 'cli'));
    walk(path.join(REPO, 'src'));
    assert.deepStrictEqual(offenders, [],
        'resolveAll() returns an array; these read a property off it and will be undefined:\n' +
        offenders.join('\n'));
});
