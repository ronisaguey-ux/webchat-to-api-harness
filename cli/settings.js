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
const memoryMod = (() => { try { return require('../src/runtime/memory'); } catch { return null; } })();

// ── The schema ─────────────────────────────────────────────────────────────
// type: bool | number | string | list | enum | secret | longtext
// risk: shown as a warning banner; these loosen a guardrail.
// Build one settings entry per tool, read from the live registry.
//
// `tools.disabled` stores the names that are OFF, so each entry's writer adds or removes
// itself from that list. The entries are generated rather than written out because a
// hand-maintained catalogue is exactly what made the Tools section look empty: the model
// had seventeen tools and the screen showed one switch.
function toolSettings(extra) {
    let defs = [];
    try {
        defs = require('../src/tools/tools').getToolDefinitions() || [];
    } catch (e) {
        defs = [];
    }
    const perTool = defs.map((t) => ({
        path: `tools.disabled::${t.name}`,
        label: t.name,
        type: 'tooltoggle',
        toolName: t.name,
        group: 'tools',
        groupTitle: 'Tools',
        default: false,          // false = NOT disabled = available
        help: String(t.description || '').replace(/\s+/g, ' ').trim(),
    }));
    return [].concat(extra, perTool);
}

const SCHEMA = [
    {
        // FIRST in the list on purpose: this is the selector that decides what "compatible"
        // means for everything below it. The shell a command runs in, how a path is spelled,
        // which command patterns are refused and which roots the sandbox grants are all
        // derived from it — see src/core/platform.js. It is a top-level key, not a nested
        // one, so it reads as a property of the harness rather than of a feature.
        id: 'platform',
        title: 'Platform',
        blurb: 'Which operating system this harness targets. Everything platform-shaped — shell, paths, command safety — follows this one choice.',
        settings: [
            {
                path: 'platform',
                label: 'Target platform',
                type: 'choice',
                options: ['linux', 'windows'],
                env: 'HARNESS_PLATFORM',
                default: 'linux',
                help: 'linux: commands run in bash, paths use forward slashes, POSIX command safety rules. '
                    + 'windows: commands run in cmd.exe, paths use backslashes, Windows command safety rules. '
                    + 'Set it to the machine your agent will actually run on — not necessarily this one.',
            },
        ],
    },
    {
        id: 'dashboard',
        title: 'Dashboard',
        blurb: 'How the live view looks and behaves. The defaults are sensible — change these only if you want to.',
        settings: [
            {
                path: 'dashboard.autoRefreshSeconds', label: 'Auto-refresh every', type: 'number', env: 'DASHBOARD_REFRESH_S',
                default: 2,
                help: 'How often the dashboard re-polls the gateway. 0 turns auto-refresh off. The default is live enough to watch a run without hammering the gateway.',
                validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 60)
                    ? null : 'must be 0-60 seconds (0 = off)',
            },
            {
                path: 'dashboard.showPacing', label: 'Show send pacing', type: 'bool',
                default: true,
                help: 'Shows how long until the next send is allowed, and whether it is ready.',
            },
            {
                path: 'dashboard.showThrottle', label: 'Show rate-limit backoff', type: 'bool',
                default: true,
                help: 'Shows the cooldown countdown when the webchat has throttled us.',
            },
            {
                path: 'dashboard.showRetries', label: 'Show retry budget', type: 'bool',
                default: false,
                help: 'Shows how many send retries remain. Useful when debugging, noise otherwise.',
                advanced: true,
            },
            {
                path: 'dashboard.showTools', label: 'Show tool count', type: 'bool',
                default: false,
                help: 'Shows how many tools the model can call.',
                advanced: true,
            },
        ],
    },

    {
        id: 'permission',
        title: 'Permission mode',
        blurb: 'How much the agent may do on its own. This is the setting most worth understanding.',
        settings: [
            {
                path: 'permission.mode', label: 'Mode', type: 'enum',
                options: ['manual', 'auto', 'yolo'],
                default: 'auto',
                help: 'When the agent asks you before acting. manual = asks for EVERY tool call. auto = asks only for risky tool calls (writes, shell, network); ordinary reads run unprompted. yolo = never asks. Passed to whichever harness you launch.',
                risk: true,
            },
            {
                path: 'permission.confirmYolo', label: 'Confirm before YOLO', type: 'bool',
                default: true,
                help: 'Ask once before launching a harness in YOLO mode. Turn off if you find the prompt noise.',
            },
        ],
    },
    {
        id: 'tools',
        title: 'Tools',
        blurb: 'Every tool the model can call, one toggle each. A tool switched off is not offered to it at all.',
        // The list is GENERATED from the tool registry (see toolSettings() below), so it
        // cannot drift from what the harness actually exposes. A hand-written copy of the
        // catalogue is how this section ended up showing only "run bash" while seventeen
        // tools were available.
        settings: toolSettings([
            {
                // The storage behind the per-tool limits editor. It needs a schema entry so
                // it is a known setting: without one saveSetting() refuses it as unknown and
                // the editor's write would silently do nothing.
                path: 'tools.limits', label: 'Per-tool limits', type: 'longtext', env: 'TOOLS_LIMITS',
                default: {}, group: 'tools', groupTitle: 'Tools',
                help: 'Limits attached to one tool, matched against its arguments. Each limit is '
                    + 'either a hard ban or an ask-the-user, and an ask applies in every permission '
                    + 'mode. Edited from the Tools screen; shown here so it can be copied between installs.',
            },
            {
                path: 'tools.bashAllowed', label: 'Allow run_bash at all', type: 'bool', env: 'BASH_ALLOWED',
                default: false, group: 'tools', groupTitle: 'Tools',
                help: 'The master switch for shell access. With this off, run_bash is unavailable no matter what else is set.',
                risk: true,
            },
        ]),
    },
    {
        id: 'prompt',
        title: 'System prompt',
        blurb: 'What the model is told about itself before every task.',
        settings: [
            {
                path: 'systemPrompt.text', label: 'System prompt', type: 'longtext',
                default: '',
                help: 'Left blank, the harness uses its built-in prompt. Set it to override for this harness.',
            },
              {
                  // A dedicated editor, not a JSON textarea. The old version showed the raw
                  // object (it rendered as "[object Object]") and gave no way to say WHICH
                  // webchat you were editing. The screen lists the real webchats, marks the
                  // ones that already have an override, and edits one at a time.
                  path: 'systemPrompt.perMode', label: 'Per-webchat prompts', type: 'permode',
                  default: {},
                  help: 'Overrides the prompt above for one webchat. Pick the webchat, then write its prompt.',
              },
        ],
    },
    {
        id: 'mcp',
        title: 'MCP servers',
        blurb: 'Attach external tool servers. Their tools are merged into the list the model can call.',
        settings: [
            {
                path: 'mcp.servers', label: 'Servers', type: 'longtext',
                default: [],
                help: 'A JSON array. Each entry is {"name":"x","command":"node","args":["..."]} for a stdio server, or {"name":"x","url":"http://..."} for one reachable over HTTP. An unreachable server is ignored, never fatal.',
            },
        ],
    },
    {
        id: 'ui',
        title: 'Appearance',
        blurb: 'How big the interface is and how much of the screen it uses.',
        settings: [
            {
                path: 'ui.margin', label: 'Side margin (columns)', type: 'number', env: 'WEBCHAT_UI_MARGIN',
                default: 2,
                help: 'Blank space each side. 0 makes the interface span the entire terminal.',
                validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 20) ? null : '0-20',
            },
            {
                path: 'ui.maxWidth', label: 'Maximum width', type: 'number', env: 'WEBCHAT_UI_MAX_WIDTH',
                default: 0,
                help: '0 means use the whole terminal. Set a number to cap it on a very wide monitor.',
            },
        ],
    },
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
                path: 'server.browserMode', label: 'Browser: headed or headless', type: 'choice',
                options: ['headed', 'headless'], env: 'BROWSER_MODE',
                help: 'headed (default) shows a real window — keep your login, and it no longer jumps on screen mid-send. '
                    + 'headless shows no window at all, but the site can sign you out and it is a fingerprint tell. '
                    + 'Minimise the headed window once and it stays minimised; raise it with `webchat window raise`.',
            },
            {
                path: 'server.headless', label: 'Headless browser (legacy bool)', type: 'bool', env: 'HEADLESS',
                help: 'Kept for existing .env files. The headed/headless setting above wins when it is set.',
                advanced: true,
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
            // The send pacing. Deliberately random so the cadence never repeats (a fixed gap
            // is itself a bot signature), but it is applied to EVERY send and a single agent
            // turn makes several — so it dominates response time. Measured: 87% of a reply
            // was this wait, not thinking (model 6.6s, gate 43s mean).
            //
            // It was env-only, i.e. invisible and uneditable from this CLI, which is why the
            // latency looked like the model being slow. Every send pays it, so the default is
            // a human typing cadence rather than a human being distracted: raise the pair if
            // you want more padding between messages.
            {
                path: 'webchat.sendGapMinMs', label: 'Send gap minimum (ms)', type: 'number', env: 'SEND_GAP_MIN_MS', envOnly: true, default: 3000,
                help: 'Shortest random wait before a deepseek send. Every send pays this, and one agent turn makes several. 0 disables the random gap.',
            },
            {
                path: 'webchat.sendGapMaxMs', label: 'Send gap maximum (ms)', type: 'number', env: 'SEND_GAP_MAX_MS', envOnly: true, default: 6000,
                help: 'Longest random wait before a deepseek send. The wait is picked fresh in [min, max] each time so the cadence never repeats.',
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
                path: 'limits.maxMalformedRounds', label: 'Malformed-JSON stop threshold', type: 'number', env: 'MAX_MALFORMED_ROUNDS',
                help: 'How many CONSECUTIVE unparseable tool-JSON replies before the run stops. The counter resets on any good parse, so this bounds a streak, not the total. A malformed reply is always reported back to the model with the exact reason it failed.',
            },
            {
                path: 'limits.malformedRetryEnabled', label: 'Auto-retry after a malformed stop', type: 'bool', env: 'MALFORMED_RETRY_ENABLED',
                help: 'When the stop threshold is hit, pause and try again by itself instead of ending the run. A model that emitted a bad shape is often fine moments later, so this salvages runs that would otherwise be lost.',
            },
            {
                path: 'limits.malformedRetryDelaySec', label: 'Auto-retry delay (seconds)', type: 'number', env: 'MALFORMED_RETRY_DELAY_SEC',
                help: 'How long to wait before each automatic retry, in SECONDS — 30, 60, 100. Default 100.',
            },
            {
                path: 'limits.malformedMaxRetries', label: 'Max auto-retries', type: 'number', env: 'MALFORMED_MAX_RETRIES',
                help: 'How many automatic retries before the run genuinely stops and waits for a wake. 0 stops immediately (same as disabling auto-retry).',
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
    return path.join(__dirname, '..', 'src', 'core', 'harness.config.json');
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
    case 'choice': {
        // One of a fixed set, matched case-insensitively so `HEADED` and `headed`
        // are the same answer. An unknown value is REJECTED (undefined) rather than
        // silently stored: a typo'd mode that falls through to a default is how a
        // setting looks applied and changes nothing.
        const want = String(value).trim().toLowerCase();
        const opts = (setting.options || []).map((o) => String(o).toLowerCase());
        return opts.includes(want) ? want : undefined;
    }
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
    // A per-tool toggle is not its own key: every one of them reads the SAME
    // `tools.disabled` array and reports whether its own name is in it. Resolved here so
    // the value shown in the list, the "is it on" question and the writer all agree.
    if (setting.type === 'tooltoggle') {
        const list = getPath(raw, 'tools.disabled');
        const off = Array.isArray(list) ? list : [];
        return { value: !off.includes(setting.toolName), source: 'file' };
    }
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
        // envOnly means the VALUE lives in .env rather than in the config file — it does not
        // mean the setting has no default. When the var is absent the gateway still applies
        // its own built-in default, so "unset" describes a setting that is very much in
        // force: the same number is running, and the display called it missing.
        //
        // A setting that carries a default therefore reports that default (source
        // "default", i.e. "not written to .env; the built-in value applies"). One without a
        // default — a secret — is genuinely unset until written.
        if (!hasEnv) {
            if (setting.default === undefined) return { value: undefined, source: 'unset' };
            return { value: coerce(setting, setting.default), source: 'default' };
        }
        return { value: coerce(setting, envVal), source: 'env', envWhere: where };
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
    // A per-setting default, so a setting can be documented and honest about what
    // applies when nothing is set. Without this a new setting reads as `undefined`,
    // and the UI cannot tell "off" from "not configured" — which matters because
    // several consumers treat a missing value differently from a false one.
    if (setting.default !== undefined) {
        return { value: coerce(setting, setting.default), source: 'default' };
    }
    return { value: undefined, source: 'default' };
}

// Every setting, resolved, in schema order.
  // dotenv defaults to the REAL .env rather than {}. `.env` is where env-backed settings
  // live, so a resolve that cannot see it reports `source: "unset"` for a setting that is
  // in fact configured and in use — the MCP did exactly that (it called resolveAll(raw) with
  // no dotenv, so an envOnly setting read back as unset the moment it was saved). A display
  // that says "unset" about a live value is the same lie as a stale connected flag.
  //
  //  Pass an explicit object to resolve against a fixture; only omitting the argument loads
  //  the file, so a test stays isolated and a caller cannot forget.
  //
  //  ★ `raw` HAD NO DEFAULT, SO OMITTING IT DID NOT LOAD THE FILE — it resolved against
  //  `undefined`, and every file-backed setting fell through to its default. The comment above
  //  described the intent; the signature did the opposite. Measured on this box: the config
  //  says platform "windows" while resolveAll() reported "linux" (source default), and
  //  file-backed settings resolved 45 -> 17 without raw. Eight callers passed raw explicitly
  //  and worked; the one that omitted it was silently wrong.
  function resolveAll(raw = loadRaw().raw, env = process.env, dotenv) {
      const dotenvVars = dotenv === undefined ? loadDotenv().vars : dotenv;
      const rows = [];
      for (const group of SCHEMA) {
          for (const s of group.settings) {
              rows.push({ setting: s, group: group.id, groupTitle: group.title, ...resolve(s, raw, env, dotenvVars) });
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
    if (setting.type === 'bool' || setting.type === 'envbool' || setting.type === 'tooltoggle') {
        return value ? 'on' : 'off';
    }
    if (setting.type === 'list') return Array.isArray(value) && value.length ? value.join(', ') : '(none)';
    return String(value);
}

// Programmatic write, for screens that save a value without going through the
// one-setting editor (a checkbox list, for instance).
//
// Returns what happened rather than assuming success: a value that is SHADOWED by an
// environment variable is written to the file and still has no effect, and a caller
// that reports "saved" there is lying to the user. The return says so.
    // ── Tour / demo mode ────────────────────────────────────────────────────
    //
    // While this is on, every write is accepted and reported as saved but NOTHING is
    // written to disk. The tutorial sends the user into real screens and tells them to
    // press things - the fastest way to teach a control panel is to let someone use it -
    // but being shown around must not leave a trail of half-changed settings behind, and
    // a user who is only exploring should never have to undo anything afterwards.
    //
    // It is deliberately a flag on the WRITER rather than a set of fake screens: the
    // screens the user sees are the real ones, so what they learn applies. Only the
    // persistence is mocked.
    let _demoMode = false;
    function setDemoMode(on) {
        const was = _demoMode;
        _demoMode = Boolean(on);
        return was;
    }
    function isDemoMode() { return _demoMode; }

    function saveSetting(dotted, value) {
        // A per-tool toggle writes membership of `tools.disabled`, not a key of its own.
        // `dotted` arrives as `tools.disabled::<name>` and is translated here, so the
        // caller works in the same id space the list uses and never has to know the
        // storage shape.
        // One entry of a MAP setting, addressed as `<map.path>::<key>`. Clearing with an
        // empty string removes the key, which is how a per-webchat prompt falls back to
        // the shared one. Without this the only way to set a single entry was to
        // read-modify-write the whole object, which is exactly the kind of whole-object
        // write that loses a concurrent edit.
        const mapEntry = /^([A-Za-z]+\.[A-Za-z]+)::(.+)$/.exec(dotted);
        if (mapEntry && BY_PATH.has(mapEntry[1])) {
            const mapPath = mapEntry[1];
            const key = mapEntry[2];
            const loaded0 = loadRaw();
            const next0 = loaded0.raw || {};
            const map = Object.assign({}, getPath(next0, mapPath) || {});
            if (String(value == null ? '' : value).trim() === '') delete map[key];
            else map[key] = String(value);
            setPath(next0, mapPath, map);
            saveRaw(next0, loaded0.file);
            return { ok: true, value: map[key] || '', shadowed: false, shadowedBy: null };
        }
        if (dotted.startsWith('tools.disabled::')) {
            const name = dotted.slice('tools.disabled::'.length);
            const loaded = loadRaw();
            const next = loaded.raw || {};
            const cur = getPath(next, 'tools.disabled');
            const set = new Set(Array.isArray(cur) ? cur : []);
            if (value) set.delete(name); else set.add(name);
            setPath(next, 'tools.disabled', [...set]);
            saveRaw(next, loaded.file);
            return { ok: true, value: !set.has(name), shadowed: false, shadowedBy: null };
        }
      if (_demoMode) {
          // Reported as saved so the screen behaves exactly as it would, and marked so a
          // caller can say "not really" on screen if it wants to.
          return { ok: true, demo: true, value, shadowed: false, shadowedBy: null };
      }

      const setting = BY_PATH.get(dotted);
      if (!setting) return { ok: false, reason: `unknown setting "${dotted}"` };

      // ★ THE WRITE TARGET DEPENDS ON THE TYPE, and this used to ignore two of them.
      // It always wrote to the config JSON, so `memory.contents` went into the config
      // while the model reads the memory FILE (the write reported success and changed
      // nothing), and an env-only secret like `__env__.API_TOKEN` went into the config
      // while the runtime reads .env. Both are "saved but inert" — the worst shape a
      // settings writer can have, because the caller is told it worked. This is the
      // single writer for BOTH the CLI and the MCP, so the fix belongs here rather than
      // in either caller.

      // Env-only: the value lives in .env, never in the config file.
      if (setting.envOnly) {
          const file = envFilePath();
          let text = '';
          try { text = fs.readFileSync(file, 'utf-8'); } catch { text = ''; }
          fs.writeFileSync(file, setEnvVar(text, setting.env, String(value)), { mode: 0o600 });
          return { ok: true, value, shadowed: false, shadowedBy: null, where: file };
      }

      // File-backed: the value IS a file. Writing it into the config JSON would leave
      // the real file untouched and the setting would appear to have no effect.
      if (setting.fileBacked) {
          if (!memoryMod || typeof memoryMod.writeMemory !== 'function') {
              return { ok: false, reason: 'the memory module is unavailable, so ' + dotted + ' cannot be written' };
          }
          memoryMod.writeMemory(String(value == null ? '' : value));
          return { ok: true, value, shadowed: false, shadowedBy: null, where: memoryMod.memoryFile() };
      }

      // loadRaw returns an ENVELOPE ({ file, raw, missing }) — writing that straight
      // back produces a config containing the envelope instead of the settings, which
      // silently reverts every value on the next boot. Write `loaded.raw`.
      const loaded = loadRaw();
      const next = loaded.raw || {};
      setPath(next, dotted, value);
      saveRaw(next, loaded.file);
    // Re-resolve so the caller learns whether the file write actually took effect.
    const after = resolve(setting, next);
    const shadowed = Boolean(after && after.shadowedBy);
    return {
        ok: true,
        value: after ? after.value : value,
        shadowed,
        shadowedBy: shadowed ? after.shadowedBy : null,
    };
}

    // Reset one setting to its built-in default.
    //
    // "Reset" has to strip EVERY layer that could be holding a value, not just the config
    // file: a setting can be set in the file, shadowed by an environment variable, or both.
    // Removing only the file value leaves the env var in charge and the setting unchanged,
    // which reads as "reset did nothing". So this removes the file entry AND the env var,
    // and reports which of the two it actually removed.
    function resetSetting(dotted) {
        const setting = BY_PATH.get(dotted);
        if (!setting) return { ok: false, reason: `unknown setting "${dotted}"` };

        const removed = [];
        const { raw, file } = loadRaw();
        const next = raw || {};
        if (getPath(next, dotted) !== undefined) {
            setPath(next, dotted, undefined);
            saveRaw(next, file);
            removed.push(path.basename(file));
        }
        if (setting.env) {
            const envFile = envFilePath();
            let text = '';
            try { text = fs.readFileSync(envFile, 'utf-8'); } catch { text = ''; }
            const without = removeEnvVar(text, setting.env);
            if (without !== text) {
                fs.writeFileSync(envFile, without, { mode: 0o600 });
                removed.push(path.basename(envFile));
            }
            delete process.env[setting.env];
        }
        const after = resolve(setting, loadRaw().raw || {});
        return {
            ok: true,
            path: dotted,
            value: after ? after.value : setting.default,
            removedFrom: removed,
            note: removed.length
                ? 'Removed from ' + removed.join(' and ') + '.'
                : 'Already at the default — nothing to remove.',
        };
    }

    module.exports = {
        SCHEMA, BY_PATH,
        getPath, setPath,
        parseEnvFile, setEnvVar, removeEnvVar,
        envFilePath, loadDotenv,
        configFilePath, loadRaw, saveRaw,
        coerce, resolve, resolveAll, countShadowed, saveSetting, resetSetting,
        setDemoMode, isDemoMode,
        listModes, display,
    };
