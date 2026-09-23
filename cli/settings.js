'use strict';
//
// settings.js — the complete setting surface, as data.
//
// `config.js` resolves every setting with the precedence
//     environment variable  >  harness.config.json  >  a built-in default
// which is the right precedence for a machine that is configured by systemd
// drop-ins, and a footgun for anyone editing the file: a value you change in
// harness.config.json does nothing if the matching env var is set, and nothing
// tells you. So this module does three jobs:
//
//   1. SCHEMA  — every setting the harness actually reads, with its env var,
//                its type, and a plain-English description. This is the single
//                source the CLI renders from; adding a setting here is what
//                makes it appear in the UI.
//   2. RESOLVE — the effective value AND WHERE IT CAME FROM, so the UI can say
//                "set by BASH_ALLOWED in the environment" instead of silently
//                ignoring an edit. `shadowedBy` is the field that makes this
//                honest.
//   3. WRITE   — atomic edits to harness.config.json (backup first) and to .env
//                for the handful of values that are env-only.
//
// Anything not in SCHEMA is still readable through `raw` (for per-mode
// selectors and quirks, which are nested and edited as a block).

const fs = require('fs');
const path = require('path');

// The memory file is file-backed, not config-JSON-backed: its `memory.contents`
// setting reads/writes the actual file. Load it lazily so a broken memory module
// cannot take the CLI down.
const memoryMod = (() => { try { return require('../memory'); } catch { return null; } })();

// ── The schema ─────────────────────────────────────────────────────────────
// type: bool | number | string | list | enum | secret | longtext
// risk: shown as a warning banner; these loosen a guardrail.
const SCHEMA = [
    {
        id: 'site',
        title: 'Webchat & connection',
        blurb: 'Which webchat the harness drives, and how it reaches the browser.',
        settings: [
            {
                path: 'webchat.mode', label: 'Webchat', type: 'mode', env: 'WEBCHAT_MODE',
                help: 'The site whose DOM, send behaviour and quirks the harness uses.',
            },
            {
                path: 'webchat.url', label: 'Target URL', type: 'string', env: 'WEBCHAT_URL',
                help: 'Left blank, the selected webchat supplies its own URL. Set it to pin one exact thread.',
                advanced: true,
            },
            {
                path: 'webchat.tabUrlSubstring', label: 'Tab URL must contain', type: 'string', env: 'TAB_URL_SUBSTRING',
                help: 'When two tabs carry the same URL, pin the connection to the one containing this text.',
                advanced: true,
            },
            {
                path: 'webchat.tabId', label: 'Tab ID', type: 'string', env: 'TAB_ID',
                help: 'Hard pin to one CDP target. Strongest form of tab pinning; survives same-URL collisions.',
                advanced: true,
            },
            {
                path: 'webchat.cdpWsUrl', label: 'CDP websocket URL', type: 'string', env: 'CDP_WS_URL',
                help: 'Set to ATTACH to a browser you already have open. Blank, the harness launches its own.',
                advanced: true,
            },
            {
                path: 'server.host', label: 'Bind host', type: 'string', env: 'HOST',
                help: 'Keep this on 127.0.0.1 unless you also set an API token.',
            },
            {
                path: 'server.port', label: 'Port', type: 'number', env: 'PORT',
                validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536) ? null : 'port must be 1-65535',
            },
            {
                path: 'server.modelName', label: 'Advertised model name', type: 'string', env: 'MODEL_NAME',
                help: 'What /v1/models reports. Your agent client sees this as the model id.',
            },
            {
                path: 'webchat.model', label: 'Model in the webchat', type: 'string', env: 'WEBCHAT_MODEL',
                help: 'Which model the webchat tab selects before a send (its own picker). Blank leaves whatever is selected.',
            },
            {
                path: 'webchat.native.deepThink', label: 'Native DeepThink', type: 'bool',
                help: 'Turns the webchat\'s own DeepThink control on/off before a send (DeepSeek).',
            },
            {
                path: 'webchat.native.search', label: 'Native web search', type: 'bool',
                help: 'Turns the webchat\'s own Search control on/off (DeepSeek/Gemini native search) — replaces a paid search key.',
            },
            {
                path: 'server.headless', label: 'Headless browser', type: 'bool', env: 'HEADLESS',
                help: 'On, no window appears — but you cannot log in. Turn off to sign in, then use Attach.',
            },
            {
                path: 'webchat.viewportW', label: 'Viewport width', type: 'number', env: 'VIEWPORT_W',
                help: 'Pins the layout viewport. Needed on WM-less X sessions where renderers freeze at launch size.',
                advanced: true,
            },
            {
                path: 'webchat.viewportH', label: 'Viewport height', type: 'number', env: 'VIEWPORT_H',
                advanced: true,
            },
            {
                path: 'webchat.loginWaitSeconds', label: 'Login wait (seconds)', type: 'number', env: 'LOGIN_WAIT_SECONDS',
                help: 'How long to wait for you to finish signing in on first launch.',
            },
        ],
    },
    {
        id: 'gates',
        title: 'Gates & sandbox',
        blurb: 'What the model is allowed to touch. These are guardrails, not a kernel jail — read the warnings.',
        settings: [
            {
                path: 'features.bashAllowed', label: 'Allow run_bash', type: 'bool', env: 'BASH_ALLOWED', risk: true,
                help: 'Lets the model execute shell commands. Double-gated: this AND the sandbox bash flag must both be on.',
            },
            {
                path: 'features.sandboxAllowBash', label: 'Sandbox: allow bash', type: 'bool', env: 'SANDBOX_ALLOW_BASH', risk: true,
                help: 'The second half of the bash gate. A command must also touch only paths inside the sandbox roots.',
            },
            {
                path: 'features.sandbox', label: 'Enable sandbox', type: 'bool', env: 'SANDBOX_ENABLED',
                help: 'Path fence for file tools and for every path-like token in a bash command. Leave this on.',
            },
            {
                path: 'network.sandboxRoots', label: 'Sandbox roots', type: 'list', env: 'SANDBOX_ROOTS',
                help: 'Comma-separated directories the model may read and write. Everything else is refused. Empty means no roots, so nothing is reachable.',
            },
            {
                path: 'limits.execTimeoutMs', label: 'Command timeout (ms)', type: 'number', env: 'EXEC_TIMEOUT_MS',
                help: 'Upper bound on any bash command the model runs.',
            },
            {
                path: 'features.rateLimitCooldownSeconds', label: 'Throttle cooldown (s)', type: 'number', env: 'RATE_LIMIT_COOLDOWN_S',
                help: 'When the site answers "Messages too frequent", cool that account this long and reply 429 instead of hammering it.',
            },
            {
                path: '__env__.API_TOKEN', label: 'API token', type: 'secret', env: 'API_TOKEN', envOnly: true,
                help: 'When set, every request needs Authorization: Bearer <token>. Required if you bind beyond localhost.',
            },
            {
                path: '__env__.SANDBOX_LOG', label: 'Log sandbox decisions', type: 'envbool', env: 'SANDBOX_LOG',
                help: 'Writes each allow/deny decision to the log. Env-only; unset means logging stays on.',
                advanced: true,
            },
        ],
    },
    {
        id: 'loops',
        title: 'Tool-call loops & limits',
        blurb: 'How long and how far the model may work before it must answer.',
        settings: [
            {
                path: 'limits.maxToolRounds', label: 'Max tool rounds', type: 'number', env: 'MAX_TOOL_ROUNDS',
                help: 'Hard ceiling on tool round-trips in one request.',
            },
            {
                path: 'limits.wrapUpRounds', label: 'Wrap-up rounds', type: 'number', env: 'WRAP_UP_ROUNDS',
                help: 'How many rounds before the ceiling to stop the model and demand its final answer — so running out yields a summary, not an error.',
            },
            {
                path: 'limits.toolContextWindow', label: 'Tool context window (chars)', type: 'number', env: 'TOOL_CONTEXT_WINDOW',
                help: 'How much of the tool definitions / history is shown to the model.',
            },
            {
                path: 'limits.timeoutMs', label: 'Request timeout (ms)', type: 'number', env: 'TIMEOUT',
                help: 'Whole-request ceiling. Thinking lanes genuinely cogitate for minutes; 30 minutes is the shipped default.',
            },
            {
                path: 'limits.emptyGraceMs', label: 'Time-to-first-token grace (ms)', type: 'number', env: 'EMPTY_GRACE_MS',
                help: 'How long a mounted-but-empty response row may stay empty before the send is called aborted. Activity extends it; this is NOT a whole-answer budget.',
            },
            {
                path: 'features.contextHandoff', label: 'Context handoff', type: 'bool', env: 'CONTEXT_HANDOFF_ENABLED',
                help: 'When the request body grows past the threshold, have the model write a handoff doc, open a fresh chat and seed it.',
            },
            {
                path: 'limits.contextHandoffThreshold', label: 'Handoff threshold (chars)', type: 'number', env: 'CONTEXT_HANDOFF_THRESHOLD',
                help: 'Measured in request-body characters. ~4 chars per token.',
            },
            {
                path: 'toolBudget.maxToolCalls', label: 'Tool-call budget', type: 'number',
                help: 'Total tool calls allowed across a whole agent session. Enforced in the opencode layer by plugins/tool-budget.js.',
            },
            {
                path: 'toolBudget.compactEvery', label: 'Compact every N calls', type: 'number',
                help: 'Compaction cadence for the tool-call history.',
                advanced: true,
            },
            {
                path: 'limits.antiSpiralMinWords', label: 'Anti-spiral min words', type: 'number',
                help: 'Responses shorter than this are not treated as a spiral candidate.',
                advanced: true,
            },
            {
                path: 'limits.maxMalformedRounds', label: 'Malformed-JSON corrections', type: 'number', env: 'MAX_MALFORMED_ROUNDS',
                help: 'How many broken tool-JSON replies get a correction before the harness gives up and returns an error.',
            },
            {
                path: 'features.toolCompactor', label: 'Compact tool results', type: 'bool', env: 'TOOL_COMPACTOR',
                help: 'Trims big tool results to head+tail before they go back to the model. Errors are never touched.',
            },
            {
                path: 'compactor.maxText', label: 'Compactor text cap (chars)', type: 'number', env: 'COMPACTOR_MAX_TEXT',
                help: 'A text field longer than this is truncated to head + tail with a marker.',
                advanced: true,
            },
            {
                path: 'compactor.maxItems', label: 'Compactor item cap', type: 'number', env: 'COMPACTOR_MAX_ITEMS',
                help: 'A result array longer than this keeps only head + tail items.',
                advanced: true,
            },
        ],
    },
    {
        id: 'behaviour',
        title: 'Agent behaviour',
        blurb: 'How the harness talks to the model and what it accepts back.',
        settings: [
            {
                path: 'features.allowPlainText', label: 'Accept plain text replies', type: 'bool', env: 'ALLOW_PLAIN_TEXT',
                help: 'Off, every reply must be exactly one fenced tool call. On, prose is accepted as the final answer too.',
            },
            {
                path: 'features.noTools', label: 'Research-only (no tools)', type: 'bool', env: 'NO_TOOLS',
                help: 'Offers the model NO work tools — only submit_answer — so research and plain-English tasks answer directly. Pair with Accept plain text for a pure research lane.',
            },
            {
                path: 'features.memory', label: 'Memory file', type: 'bool', env: 'MEMORY_ENABLED',
                help: 'Keeps a memory file the model can read/edit (read_memory/edit_memory) and includes it in the system prompt.',
            },
            {
                path: 'memory.maxChars', label: 'Memory size cap (chars)', type: 'number', env: 'MAX_MEMORY_CHARS',
                help: 'The memory file is capped at this size — it rides into every request.',
                advanced: true,
            },
            {
                path: 'memory.contents', label: 'Memory contents', type: 'longtext', fileBacked: true,
                help: 'The memory file itself — edit here, or let the model edit it with edit_memory.',
            },
            {
                path: 'features.ignoreClientSystem', label: 'Ignore caller system prompt', type: 'bool', env: 'IGNORE_CLIENT_SYSTEM',
                help: 'On, the caller\'s own system message is dropped and only the harness prompt is sent. Required for agent callers whose prompt is their own harness rulebook.',
            },
            {
                path: 'features.narration', label: 'Narration', type: 'bool', env: 'NARRATION',
                help: 'Asks for a one-line human note before each tool call. Handy when watching by hand; adds tokens to autonomous runs.',
            },
            {
                path: 'features.antiSpiral', label: 'Anti-spiral detection', type: 'bool', env: 'ANTI_SPIRAL',
                help: 'Detects a model looping on the same reasoning and stops it.',
            },
            {
                path: 'features.passthroughFormat', label: 'Passthrough format', type: 'bool', env: 'PASSTHROUGH_FORMAT',
                help: 'Do not append the harness output contract — the caller is supplying its own.',
                advanced: true,
            },
            {
                path: 'features.skipBrowser', label: 'Skip browser', type: 'bool', env: 'SKIP_BROWSER',
                help: 'Run without a browser at all. Only useful for testing config plumbing.',
                advanced: true,
            },
            {
                path: 'features.blockedCss', label: 'Block stylesheets', type: 'bool', env: 'BLOCKED_CSS',
                help: 'Blocks CSS at the CDP layer for speed. SPAs with fragile layouts can break; leave off for Gemini.',
                advanced: true,
            },
            {
                path: 'network.blockedUrlsExtra', label: 'Extra URL block patterns', type: 'list', env: 'BLOCKED_URLS_EXTRA',
                help: 'Extra glob patterns to abort at the network layer. Images, fonts and media are already blocked.',
                advanced: true,
            },
            {
                path: 'systemPrompt.text', label: 'System prompt', type: 'longtext',
                help: 'Blank uses the harness built-in. A per-webchat override wins over this.',
            },
        ],
    },
    {
        id: 'advanced',
        title: 'Selectors & files',
        blurb: 'The escape hatch for when a site changes its DOM. Comma-separated, first match wins.',
        settings: [
            {
                path: 'webchat.selectors.input', label: 'Input selector', type: 'list', env: 'SELECTOR_INPUT', advanced: true,
                help: 'The composer.',
            },
            { path: 'webchat.selectors.send', label: 'Send selector', type: 'list', advanced: true },
            { path: 'webchat.selectors.message', label: 'Message selector', type: 'list', advanced: true, help: 'The rows that hold replies.' },
            { path: 'webchat.selectors.newChat', label: 'New-chat selector', type: 'list', advanced: true },
            {
                path: 'webchat.threadPattern', label: 'Thread URL pattern', type: 'string', advanced: true,
                help: 'Regex proving a new chat got a real thread, e.g. /app/[0-9a-f]{6,} for Gemini.',
            },
            { path: 'paths.cookieFile', label: 'Cookie file', type: 'string', env: 'COOKIE_FILE', advanced: true },
            { path: 'paths.memoryFile', label: 'Memory file path', type: 'string', env: 'MEMORY_FILE', advanced: true, help: 'Where the persistent memory file lives.' },
        ],
    },
];

// Flat index for lookup by dotted path.
const BY_PATH = new Map();
for (const group of SCHEMA) {
    for (const s of group.settings) BY_PATH.set(s.path, { ...s, group: group.id, groupTitle: group.title });
}

// ── Path helpers ───────────────────────────────────────────────────────────
function getPath(obj, dotted) {
    return dotted.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
    const keys = dotted.split('.');
    let cur = obj;
    for (const k of keys.slice(0, -1)) {
        if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
        cur = cur[k];
    }
    const last = keys[keys.length - 1];
    if (value === undefined) delete cur[last];
    else cur[last] = value;
    return obj;
}

// ── .env handling ──────────────────────────────────────────────────────────
function parseEnvFile(text) {
    const out = {};
    for (const raw of String(text).split('\n')) {
        let line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        // dotenv accepts `export KEY=value` in a .env file, so a parser that
        // does not strip the prefix stores a key literally named "export KEY"
        // and the real setting is never found.
        line = line.replace(/^export\s+/, '');
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // Strip one layer of matching quotes, the way dotenv does.
        if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

// Sets or replaces one key, preserving every other line and every comment.
function setEnvVar(envText, key, value) {
    const lines = String(envText).split('\n');
    const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
    let replaced = false;
    const next = lines.map((l) => {
        if (re.test(l)) {
            replaced = true;
            return `${key}=${value}`;
        }
        return l;
    });
    if (!replaced) {
        if (next.length && next[next.length - 1].trim() !== '') next.push(`${key}=${value}`);
        else next.splice(next.length - 1, 0, `${key}=${value}`);
    }
    return next.join('\n');
}

function removeEnvVar(envText, key) {
    const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
    return String(envText)
        .split('\n')
        .filter((l) => !re.test(l))
        .join('\n');
}

// ── Config file location ───────────────────────────────────────────────────
// There are TWO config files on a working install and they are not the same
// file: `harness/harness.config.json` (in the clone, the template that ships)
// and the real one OUTSIDE the clone, which `harness/.env` points at via
// HARNESS_CONFIG. Editing the wrong one looks like the CLI is broken. So the
// resolution order mirrors what the harness itself does at boot:
//   1. an explicit path
//   2. HARNESS_CONFIG in the real environment
//   3. HARNESS_CONFIG in harness/.env  (what dotenv sets at boot)
//   4. harness/harness.config.json
function envFilePath(explicit) {
    if (explicit) return path.resolve(explicit);
    if (process.env.ENV_FILE) return path.resolve(process.env.ENV_FILE);
    return path.join(__dirname, '..', '.env');
}

function loadDotenv(explicit) {
    const file = envFilePath(explicit);
    if (!fs.existsSync(file)) return { file, vars: {}, missing: true };
    try {
        return { file, vars: parseEnvFile(fs.readFileSync(file, 'utf-8')), missing: false };
    } catch (e) {
        return { file, vars: {}, missing: false, error: e };
    }
}

function configFilePath(explicit) {
    if (explicit) return path.resolve(explicit);
    if (process.env.HARNESS_CONFIG) return path.resolve(process.env.HARNESS_CONFIG);
    const dotenv = loadDotenv();
    if (dotenv.vars.HARNESS_CONFIG) return path.resolve(dotenv.vars.HARNESS_CONFIG);
    return path.join(__dirname, '..', 'harness.config.json');
}

function loadRaw(explicit) {
    const file = configFilePath(explicit);
    if (!fs.existsSync(file)) return { file, raw: {}, missing: true };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return { file, raw: (parsed && typeof parsed === 'object') ? parsed : {}, missing: false };
    } catch (e) {
        return { file, raw: {}, missing: false, error: e };
    }
}

// Atomic write, with a one-shot backup of the previous contents. A half-written
// config is the worst outcome available here: the harness reads it once at boot
// and a truncated file silently reverts every setting to its default.
function saveRaw(raw, explicit) {
    const file = configFilePath(explicit);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(path.dirname(file), `.${path.basename(file)}.bak-${stamp}`));
    } else if (!fs.existsSync(path.dirname(file))) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, file);
    return file;
}

// ── Resolution ─────────────────────────────────────────────────────────────
// Coerce a schema `type` from either an env string or a JSON value.
function coerce(setting, value) {
    if (value === undefined || value === null) return undefined;
    switch (setting.type) {
    case 'bool': case 'envbool':
        return value === true || String(value).toLowerCase() === 'true';
    case 'number': {
        const n = Number(value);
        return Number.isNaN(n) ? undefined : n;
    }
    case 'list':
        if (Array.isArray(value)) return value.map(String);
        return String(value).split(',').map((s) => s.trim()).filter(Boolean);
    default:
        return String(value);
    }
}

// What the harness will ACTUALLY see, and who decided it.
//
// `dotenv` is the parsed harness/.env. It matters as much as the real
// environment: at boot the harness calls dotenv.config(), so every line in that
// file becomes a process.env entry and therefore OUTRANKS harness.config.json.
// A CLI that ignored this would let you edit `webchat.mode` in the file, save
// it, and change nothing — on this install WEBCHAT_MODE=gemini sits in .env
// doing exactly that.
function resolve(setting, raw, env = process.env, dotenv = {}) {
    // File-backed settings (memory.contents) read the real file, not config JSON.
    if (setting.fileBacked) {
        const file = memoryMod ? memoryMod.memoryFile() : '';
        let value = '';
        try { value = fs.readFileSync(file, 'utf-8'); } catch { /* empty memory */ }
        return { value, source: 'memory', memoryFile: file };
    }
    const fromProcess = setting.env ? env[setting.env] : undefined;
    const fromDotenv = setting.env ? dotenv[setting.env] : undefined;
    const envVal = (fromProcess !== undefined && fromProcess !== '') ? fromProcess
        : ((fromDotenv !== undefined && fromDotenv !== '') ? fromDotenv : undefined);
    const where = (fromProcess !== undefined && fromProcess !== '') ? 'environment'
        : ((fromDotenv !== undefined && fromDotenv !== '') ? 'harness/.env' : null);
    const hasEnv = envVal !== undefined;

    if (setting.type === 'envbool') {
        // SANDBOX_LOG is inverted: it logs unless explicitly 'false'.
        if (!hasEnv) return { value: true, source: 'default', detail: 'unset — logging stays on' };
        return { value: String(envVal).toLowerCase() !== 'false', source: 'env', envWhere: where };
    }
    if (setting.envOnly) {
        if (!hasEnv) return { value: undefined, source: 'unset' };
        return { value: envVal, source: 'env', envWhere: where };
    }

    const fileVal = getPath(raw, setting.path);
    const hasFile = fileVal !== undefined && fileVal !== null && fileVal !== '';

    if (hasEnv) {
        return {
            value: coerce(setting, envVal),
            source: 'env',
            envWhere: where,
            // The load-bearing field: an env var beats the file, so an edit in
            // the UI would silently do nothing. The UI must say so, and offer to
            // clear the shadowing line.
            shadowedBy: setting.env,
            shadowedWhere: where,
            shadowedFileValue: hasFile ? coerce(setting, fileVal) : undefined,
        };
    }
    if (hasFile) return { value: coerce(setting, fileVal), source: 'file' };
    return { value: undefined, source: 'default' };
}

// Every setting, resolved, in schema order.
function resolveAll(raw, env = process.env, dotenv = {}) {
    const rows = [];
    for (const group of SCHEMA) {
        for (const s of group.settings) {
            rows.push({ setting: s, group: group.id, groupTitle: group.title, ...resolve(s, raw, env, dotenv) });
        }
    }
    return rows;
}

function countShadowed(rows) {
    return rows.filter((r) => r.shadowedBy).length;
}

// The webchat modes the config knows about, with what each carries.
function listModes(raw) {
    const modes = (raw && raw.webchatModes) || {};
    return Object.entries(modes).map(([id, m]) => ({
        id,
        url: (m && m.url) || '',
        selectors: (m && m.selectors) || {},
        quirks: (m && m.quirks) || {},
        threadPattern: (m && m.threadPattern) || '',
        emptyGraceMs: (m && m.emptyGraceMs) || 0,
    }));
}

// Format a value for display.
function display(setting, value) {
    if (value === undefined || value === null || value === '') return '(not set)';
    if (setting.type === 'secret') return '••••••••';
    if (setting.type === 'bool' || setting.type === 'envbool') return value ? 'on' : 'off';
    if (setting.type === 'list') return Array.isArray(value) && value.length ? value.join(', ') : '(none)';
    return String(value);
}

module.exports = {
    SCHEMA, BY_PATH,
    getPath, setPath,
    parseEnvFile, setEnvVar, removeEnvVar,
    envFilePath, loadDotenv,
    configFilePath, loadRaw, saveRaw,
    coerce, resolve, resolveAll, countShadowed,
    listModes, display,
};
