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

import fs = require('fs');
import path = require('path');

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
export interface SettingRow {
    path: string;
    label?: string;
    type?: string;
    toolName?: string;
    group?: string;
    groupTitle?: string;
    default?: unknown;
    help?: string;
    [key: string]: unknown;
}

function toolSettings(extra: SettingRow[]): SettingRow[] {
    let defs: Array<{ name: string; description?: string }> = [];
    try {
        // src/tools/tools.ts is not converted yet: reach the source file from dist/.
        defs = (require(path.join(__dirname, '..', '..', 'src', 'tools', 'tools')) as { getToolDefinitions: () => Array<{ name: string; description?: string }> }).getToolDefinitions() || [];
    } catch (e) {
        defs = [];
    }
    const perTool: SettingRow[] = defs.map((t) => ({
        path: `tools.disabled::${t.name}`,
        label: t.name,
        type: 'tooltoggle',
        toolName: t.name,
        group: 'tools',
        groupTitle: 'Tools',
        default: false,          // false = NOT disabled = available
        help: String(t.description || '').replace(/\s+/g, ' ').trim(),
    }));
    return ([] as SettingRow[]).concat(extra, perTool);
}

const SCHEMA: Array<{ id: string; title: string; blurb?: string; settings: SettingRow[] }> = [
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
                validate: (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 60)
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
            {
                // 09-26: the tools that reach OUTSIDE the sandbox — Telegram, another
                // agent's inbox, the oculus pipeline. Off by default: messaging the owner
                // or feeding another agent is consent the operator has to give, not a
                // side effect of a file happening to exist. A tool is still additionally
                // dropped when the file, script or bridge it talks to is absent, so this
                // switch can only ever enable a tool that could actually work.
                path: 'tools.outwardEnabled', label: 'Outward-facing tools', type: 'bool', env: 'OUTWARD_TOOLS_ENABLED',
                default: false, group: 'tools', groupTitle: 'Tools',
                help: 'Master switch for the tools that leave this machine or talk to another agent: '
                    + 'audit_status, telegram_send, send_message_to_main, send_message_to_antigravity, '
                    + 'send_telegram_message. Off by default, and each is offered only when its own '
                    + 'target exists. Set OUTWARD_TOOL_<NAME>=true to enable a single one alone.',
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
                validate: (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 20) ? null : '0-20',
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
                validate: (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536) ? null : 'port must be 1-65535',
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
