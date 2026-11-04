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
const d = require('./daemon.js');

// Permission mode. The owner's definition — it is about WHEN the agent asks, not
// about what the agent is capable of:
//   manual — asks for EVERY tool call.
//   auto   — asks only for RISKY tool calls; ordinary ones go through.
//   yolo   — never asks.
const MODES = {
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
        modelFlag: (env) => ['-m', opencodeModelId(env.HARNESS_MODEL_NAME)],
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
