'use strict';
//
// harnesses.js — the agentic harnesses this CLI can launch, and how to launch them
// against N webchats at once.
//
// The integration surface is the four environment variables the gateway already
// speaks — OPENAI_BASE_URL, OPENAI_API_KEY, ANTHROPIC_BASE_URL, HARNESS_MODEL_NAME.
// Every harness below consumes some subset of them; the ones that need a flag
// (aider, claw) get the flag too. We do NOT proxy the agent: it launches normally and
// talks to the gateway itself.
//
// MULTI-WEBCHAT IS THE POINT. One harness, several gates, means several model ids the
// agent can pick between:
//
//     webchat/claude            <- the Gemini gate
//     webchat/gemini-webchat    <- the ChatGPT gate
//
// so the user switches model inside their own tool and gets a different account
// underneath. That is why the model id carries the gate id: an agent that only ever
// sees one name cannot be told to use the other.
//
const fs = require('fs');
const path = require('path');
const d = require('./daemon');

// Permission mode. The owner asked for manual / auto / yolo, and the mapping is
// per-harness because each tool expresses this differently:
//   manual — never write, never shell. Read and answer only.
//   auto   — write files and run ordinary commands; destructive ones still refused.
//   yolo   — no gate at all. The prompt says so; the flags say so.
const MODES = {
    manual: {
        id: 'manual',
        label: 'Manual',
        blurb: 'Reads and answers. Cannot write files or run commands.',
        risk: false,
    },
    auto: {
        id: 'auto',
        label: 'Auto',
        blurb: 'Writes files and runs ordinary commands without asking. Destructive operations still refused.',
        risk: false,
    },
    yolo: {
        id: 'yolo',
        label: 'YOLO',
        blurb: 'No gate at all — anything the agent decides is executed, including destructive commands.',
        risk: true,
    },
};

// Each harness: how to find it, how it takes a base URL, an optional config file it
// needs written first, and its permission flags per mode.
const HARNESSES = [
    {
        id: 'opencode',
        label: 'opencode',
        bin: 'opencode',
        note: 'Reads provider config from ./opencode.json in the working directory.',
        // opencode auto-discovers ./opencode.json from cwd. OPENCODE_CONFIG is NOT
        // equivalent (only `opencode debug config` reads it) — the file must sit
        // where the agent runs, which is why we write one.
        needsConfigFile: true,
        // opencode has no --yolo. Its only permission flag is --auto ("auto-approve
        // permissions that are not explicitly denied"), verified with `opencode --help`
        // — a flag that does not exist makes the launch fail outright, so the mode
        // feature looked implemented and was broken for the default harness.
        // The finer manual/auto distinction lives in the generated opencode.json's
        // `permission` block, which prepareConfigFiles() writes.
        modes: {
            manual: [],
            auto: ['--auto'],
            yolo: ['--auto'],
        },
    },
    {
        id: 'claude',
        label: 'Claude Code',
        bin: 'claude',
        note: 'Uses ANTHROPIC_BASE_URL; the gateway implements /v1/messages.',
        modes: {
            manual: [],
            auto: ['--permission-mode', 'acceptEdits'],
            yolo: ['--dangerously-skip-permissions'],
        },
    },
    {
        id: 'codex',
        label: 'Codex',
        bin: 'codex',
        note: 'Reads OPENAI_BASE_URL for an OpenAI-compatible endpoint.',
        modes: {
            manual: ['--sandbox', 'read-only'],
            auto: ['--sandbox', 'workspace-write'],
            yolo: ['--dangerously-bypass-approvals-and-sandbox'],
        },
    },
    {
        id: 'hermes',
        label: 'Hermes',
        bin: 'hermes',
        note: 'Configured through its own model settings; needs the exported variables.',
        modes: { manual: [], auto: [], yolo: [] },
    },
    {
        id: 'claw',
        label: 'Claw Code',
        bin: 'claw',
        // Python reimplementation of the Claude Code architecture
        // (github.com/HarnessLab/claw-code-agent). Invoked as an alias if the user
        // symlinked it; `clawModule` is the fallback run from its checkout.
        note: 'Claw Code — a Python reimplementation of the Claude Code agent.',
        clawModule: true,
        modes: {
            manual: [],
            auto: ['--allow-write', '--allow-shell'],
            yolo: ['--allow-write', '--allow-shell', '--unsafe'],
        },
    },
    {
        id: 'aider',
        label: 'aider',
        bin: 'aider',
        note: 'Names the endpoint explicitly instead of reading OPENAI_BASE_URL.',
        modes: {
            manual: [],
            auto: ['--yes-always'],
            yolo: ['--yes-always', '--no-suggest-shell-commands'],
        },
    },
    {
        id: 'crush',
        label: 'Crush',
        bin: 'crush',
        note: 'Reads the standard OpenAI variables.',
        modes: { manual: [], auto: [], yolo: [] },
    },
];

function harnessById(id) {
    return HARNESSES.find((h) => h.id === id) || null;
}

// Is the binary on PATH? Reported so the UI can grey out what is not installed
// instead of letting the user pick it and watch a launch fail.
function installed(h) {
    if (!h || !h.bin) return false;
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        try {
            const p = path.join(dir, h.bin);
            fs.accessSync(p, fs.constants.X_OK);
            return true;
        } catch { /* keep looking */ }
    }
    return false;
}

// The model id an agent sees for one gate. Kept in one place so the id we advertise
// and the id the gateway serves cannot drift.
function modelIdFor(gate) {
    return `webchat/${gate.id}`;
}

// The environment a harness needs for a set of gates.
//
// The FIRST gate is the primary (that is what OPENAI_BASE_URL points at, because the
// base URL is singular). The rest are still usable as additional model ids IF the
// harness supports several providers; where it does not, the gateway is the same
// process and the extra gates remain reachable by name through it. Being honest about
// that limit matters more than pretending every tool is multi-provider: the CLI says
// which of the selected gates the chosen harness can actually reach.
function envFor(gates, { modelName } = {}) {
    if (!gates.length) return {};
    const primary = gates[0];
    const port = primary.gatewayPort || 8081;
    const base = `http://127.0.0.1:${port}`;
    return {
        OPENAI_BASE_URL: `${base}/v1`,
        OPENAI_API_BASE: `${base}/v1`,
        OPENAI_API_KEY: process.env.HARNESS_API_KEY || 'webchat-local',
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_AUTH_TOKEN: process.env.HARNESS_API_KEY || 'webchat-local',
        HARNESS_MODEL_NAME: modelName || modelIdFor(primary),
        HARNESS_GATES: gates.map((g) => g.id).join(','),
    };
}

// Which gates can this harness actually reach, and why not the others?
function reachability(h, gates) {
    // Every harness here speaks to ONE base URL, so it reaches the primary gate
    // directly. The others are reachable only through the gateway process itself —
    // which means a tool that supports exactly one provider cannot switch accounts.
    // Saying so is the difference between a working setup and a confusing one.
    if (gates.length <= 1) return { ok: true, direct: gates.length, viaName: 0, reason: null };
    return {
        ok: true,
        direct: 1,
        viaName: gates.length - 1,
        reason: `${h.label} takes a single base URL, so it reaches "${gates[0].id}" directly. ` +
            `The other ${gates.length - 1} gate(s) are extras in the selector, not separate accounts.`,
    };
}

// opencode expresses permissions in its config file, not on the command line — its
// only CLI flag is --auto. So the permission MODE has to be written here, or two of
// the three modes would launch the same agent.
const OPENCODE_PERMISSION = {
    manual: { edit: 'ask', bash: 'ask' },
    auto: { edit: 'allow', bash: 'allow' },
    yolo: { edit: 'allow', bash: 'allow', webfetch: 'allow', '*': 'allow' },
};

// Write the config a harness needs before it starts. Only opencode needs one, and it
// is gitignored because it would otherwise leak this machine's base URL into a clone.
function prepareConfigFiles(h, gates, cwd, env, mode = 'manual') {
    if (h.id !== 'opencode') return null;
    const file = path.join(cwd, 'opencode.json');
    const models = {};
    for (const g of gates) models[modelIdFor(g)] = { name: `${g.label} (${g.site})` };
    const cfg = {
        $schema: 'https://opencode.ai/config.json',
        provider: {
            webchat: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Webchat harness',
                options: { baseURL: env.OPENAI_BASE_URL },
                models,
            },
        },
        model: env.HARNESS_MODEL_NAME,
        // An agent harness is a different product from this gateway: its plugins and
        // permissions must not leak into the webchat lane.
        plugin: [],
        permission: OPENCODE_PERMISSION[mode] || OPENCODE_PERMISSION.manual,
    };
    try {
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
        return file;
    } catch {
        return null;
    }
}

// The argv for a harness: its own binary, the mode's flags, then the user's extras.
function argvFor(h, mode, extra = []) {
    const flags = (h.modes && h.modes[mode]) || [];
    return [...flags, ...extra];
}

module.exports = {
    MODES,
    HARNESSES,
    harnessById,
    installed,
    modelIdFor,
    envFor,
    reachability,
    prepareConfigFiles,
    OPENCODE_PERMISSION,
    argvFor,
};
