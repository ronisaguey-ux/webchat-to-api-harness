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
import fs = require('fs');
import path = require('path');
import d = require('./daemon');

// Permission mode. The owner's definition — it is about WHEN the agent asks, not
// about what the agent is capable of:
//   manual — asks for EVERY tool call.
//   auto   — asks only for RISKY tool calls; ordinary ones go through.
//   yolo   — never asks.
export interface HarnessMode {
    id: string;
    label: string;
    blurb: string;
    risk: boolean;
}

export interface HarnessGate {
    id: string;
    site?: string;
    label?: string;
    gatewayPort?: number;
    connected?: boolean;
}

export interface HarnessDefinition {
    id: string;
    label: string;
    bin: string;
    note?: string;
    needsConfigFile?: boolean;
    modelFlag?: string[] | ((env: Record<string, string>) => Array<string | undefined>);
    clawModule?: boolean;
    needsModel?: boolean;
    modes: Record<string, string[]>;
}

export interface EnvOptions {
    modelName?: string;
    hubPort?: number;
}

const MODES: Record<string, HarnessMode> = {
    manual: {
        id: 'manual',
        label: 'Manual',
        blurb: 'Asks before every tool call. Nothing runs until you approve it.',
        risk: false,
    },
    auto: {
        id: 'auto',
        label: 'Auto',
        blurb: 'Asks only for risky tool calls (writes, shell, network). Ordinary reads run without a prompt.',
        risk: false,
    },
    yolo: {
        id: 'yolo',
        label: 'YOLO',
        blurb: 'Never asks. Every tool call runs unprompted, including destructive ones.',
        risk: true,
    },
};

// Each harness: how to find it, how it takes a base URL, an optional config file it
// needs written first, and its permission flags per mode.
const HARNESSES: HarnessDefinition[] = [
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
        // The MODEL is pinned on the command line, not only in the config file. opencode
        // merges ./opencode.json with the user's own global config, and the global one
        // names a paid provider - so a launch that relied on the config file alone came up
        // on the paid API while the webchat sat unused. Live: the agent's status bar read
        // "DeepSeek V4.1 Flash (paid API)" with `model: webchat/deepseek` sitting in the
        // config right beside it. An explicit -m cannot be out-voted by a merge.
        // The flag must be the PROVIDER-QUALIFIED id. opencode only accepts `webchat/<key>`
        // in -m; a bare `deepseek-webchat` matches no registered model, so opencode falls
        // back to the user's GLOBAL default (measured: providerID=openai
        // modelID=gpt-5.6-terra-pro, then "AI_APICallError: Not Found" on every send).
        // Qualified, the same launch resolves to webchat/deepseek-webchat and the request
        // reaches the gateway. `opencode models` is the oracle: it lists the ids that exist.
        modelFlag: (env: Record<string, string>) => ['-m', opencodeModelId(env.HARNESS_MODEL_NAME)],
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

function harnessById(id: unknown): HarnessDefinition | null {
    return HARNESSES.find((h) => h.id === id) || null;
}

// Is the binary on PATH? Reported so the UI can grey out what is not installed
// instead of letting the user pick it and watch a launch fail.
function installed(h: HarnessDefinition | null | undefined): boolean {
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
function modelIdFor(gate: HarnessGate): string {
    // <site>-webchat: the id is the model NAME the harness sends, so it has to be the one
    // the gateway answers to. See webchat-models.js.
    return `${gate.site || gate.id}-webchat`;
}

// The model id opencode needs, which is NOT the id the gateway answers to.
//
// These are two different namespaces and conflating them is what broke every launch:
//   • the GATEWAY answers to  deepseek-webchat        (that is HARNESS_MODEL_NAME, and it
//     is what goes in the request body)
//   • opencode SELECTS        webchat/deepseek-webchat (provider + model key)
// opencode's -m takes only the second. Given the first it resolves nothing and silently
// falls back to the user's global default — measured: providerID=openai
// modelID=gpt-5.6-terra-pro, then "AI_APICallError: Not Found" on every send, which is
// what "it launched as GPT-5.6 Terra instead of deepseek webchat" was.
//
// Only opencode needs the qualified form; every other harness reads the env var directly.
function opencodeModelId(modelName: string | undefined, providerId: string = 'webchat'): string | undefined {
    if (!modelName) return modelName;
    // Already qualified (contains a slash) — do not double-prefix it.
    return modelName.includes('/') ? modelName : `${providerId}/${modelName}`;
}

// The environment a harness needs for a set of gates.
//
// The FIRST gate is the primary (that is what OPENAI_BASE_URL points at, because the
// base URL is singular). The rest are still usable as additional model ids IF the
// harness supports several providers; where it does not, the gateway is the same
// process and the extra gates remain reachable by name through it. Being honest about
// that limit matters more than pretending every tool is multi-provider: the CLI says
// which of the selected gates the chosen harness can actually reach.
function envFor(gates: HarnessGate[], { modelName, hubPort }: EnvOptions = {}): Record<string, string> {
    if (!gates.length) return {};
    const primary = gates[0];
    // With a hub running, the harness gets ONE url and every connected webchat is
    // reachable through it -- including the toggle ids, which are just more models.
    // Without one it falls back to the first gate, which is what a single-webchat
    // setup has always used.
    const port = hubPort || primary.gatewayPort || 8081;
    const base = `http://127.0.0.1:${port}`;
    return {
        OPENAI_BASE_URL: `${base}/v1`,
        OPENAI_API_BASE: `${base}/v1`,
        OPENAI_API_KEY: process.env.HARNESS_API_KEY || 'webchat-local',
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_AUTH_TOKEN: process.env.HARNESS_API_KEY || 'webchat-local',
        // WITHOUT THIS the claude harness sends its OWN default model name (e.g.
        // claude-sonnet-4-20250514), which the /v1/messages route does not recognise: it
        // falls through WEBCHAT_ROUTES and proxies to the PAID upstream, returning
        // "Authentication Fails (auth header format should be Bearer sk-...)".
        // Measured: 'deepseek-webchat' -> 200 (our tab), 'claude-sonnet-4-...' -> 401 paid.
        // Setting it here is the difference between using the webchat and billing an API.
        ANTHROPIC_MODEL: modelName || modelIdFor(primary),
        HARNESS_MODEL_NAME: modelName || modelIdFor(primary),
        HARNESS_GATES: gates.map((g) => g.id).join(','),
    };
}

// Which gates can this harness actually reach, and why not the others?
function reachability(h: HarnessDefinition, gates: HarnessGate[], hubPort?: number): Record<string, unknown> {
    // With the hub, every connected webchat is reachable from the one url because each
    // is published as its own model id. Without it the harness only sees the primary
    // gate, and a tool that supports exactly one provider cannot switch accounts.
    // Saying which of the two you have is the difference between a working setup and a
    // confusing one.
    if (hubPort) return { ok: true, direct: gates.length, viaName: 0, hub: true, reason: null };
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
// The commands `auto` stops for. Everything else runs. The point of the mode is that a
// normal working session - reading, editing, running tests - never interrupts the user,
// and only something genuinely destructive or irreversible asks first.
//
// This is the same doctrine as the sandbox's own danger list (src/core/platform.js):
// losing work, escalating privilege, rewriting history, or shipping a secret off the box.
const RISKY_BASH = [
    // destroying a filesystem
    'rm -rf*', 'rm -fr*', 'rm -r *', 'rm -f *', 'dd *', 'mkfs*', 'shred*', '> /dev/sd*',
    // privilege and machine state
    'sudo *', 'su *', 'systemctl *', 'service *', 'shutdown*', 'reboot*', 'pkill *', 'kill -9 *',
    // history rewriting: irreversible once pushed
    'git push --force*', 'git push -f*', 'git reset --hard*', 'git clean*',
    // taking permissions away (or handing them out) recursively
    'chmod -R*', 'chown -R*',
    // piping the internet straight into a shell
    'curl *| sh*', 'curl *| bash*', 'wget *| sh*', 'wget *| bash*',
    // databases and containers
    'drop database*', 'drop table*', 'docker rm*', 'docker rmi*', 'docker volume rm*',
    'docker system prune*',
    // a secret leaving this machine
    '*ghp_*', '*TELEGRAM_TOKEN*', '*BOT_TOKEN*', '*API_KEY*',
    // and the same shapes on Windows
    'format *', 'del /f /s /q*', 'rd /s /q*', 'rmdir /s /q*', 'Remove-Item -Recurse -Force*',
];

const OPENCODE_PERMISSION = {
    // Bob's semantics: manual asks for EVERY tool call, auto proceeds by itself and asks
    // only for the risky ones, yolo never asks.
    //
    // `auto` used to ask on edit, write, bash AND webfetch - which is most of what an
    // agent does, so it behaved like "manual with extra steps" and stopped the user on
    // every file change. The majority is allowed now and only RISKY_BASH interrupts.
    // `manual` still asks for everything, so the three modes stay distinct.
    manual: { '*': 'ask', edit: 'ask', bash: 'ask' },
