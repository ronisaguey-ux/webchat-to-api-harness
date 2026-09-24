# Webchat-to-API Converter

**Note:** This harness is best used with DeepSeek webchat (chat.deepseek.com). It is the primary target and most thoroughly tested.

An OpenAI- **and** Anthropic-compatible API backed by a real webchat tab
(DeepSeek, ChatGPT, Claude.ai, …) driven with Puppeteer. Lets any agentic
wrapper (Aider, LiteLLM clients, Claude Code via `ANTHROPIC_BASE_URL`) talk to
a webchat session you own, with tool-call support (read/write files, bash, …).

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code / Aider / any wrapper                          │
│      │                                                      │
│      ▼                                                      │
│  This API  (http://localhost:8080)                          │
│      │                                                      │
│      ▼                                                      │
│  Puppeteer → webchat tab (already open, logged in)          │
│      │                                                      │
│      ▼                                                      │
│  types prompt → clicks send → waits for stable response     │
│      │                                                      │
│      ▼                                                      │
│  parses optional tool-call JSON → executes tool → feeds     │
│  result back → final answer returned                        │
└─────────────────────────────────────────────────────────────┘
```

## Requirements

| | |
|---|---|
| **Node.js** | **20.12 or newer.** Puppeteer 25 requires it; `setup.sh` refuses to start on anything older. |
| **A webchat account** | You log in **once, by hand**, in a normal Chrome window. The harness drives that browser — it never has your password and never solves a login for you. |
| **A browser** | Puppeteer downloads a matching Chrome on `npm install`. To drive your *own* Chrome instead (which keeps the login), launch it with `--remote-debugging-port=9222` and point `CDP_WS_URL` at it. |

**Nothing else.** No Python, no `xdotool`, no X11, no display server. Window control
runs over CDP (`webchat window raise|drop|maximize|status`), so it behaves the same on
Linux, macOS and Windows. It can run with the browser window minimised, off-screen, or
headless — the browser is not supposed to be in your way, and the default is now to
leave it where you put it.

**Why a webchat at all:** this turns a chat session you already pay for into an
OpenAI- and Anthropic-compatible endpoint. No API key, no per-token billing — but it is
only as good as the webchat, and each site is a separate integration with its own
quirks. DeepSeek is the primary, most-tested target.

## Install

```bash
git clone https://github.com/ronisaguey-ux/webchat-to-api-harness.git
cd webchat-to-api-harness
npm install                # also downloads a matching Chrome
cp .env.example .env       # then fill in what the site needs
./webchat                  # menu-driven: it checks your setup and tells you what is missing
```

One-time login — you do this, not the CLI:

```bash
./webchat setup     # pick the site, then "Open the browser"
#   ...sign in by hand in the window that appears...
./webchat doctor    # confirm the tab is found and logged in
```

Then point your agent at the API:

```bash
export OPENAI_BASE_URL=http://localhost:8080/v1
export OPENAI_API_KEY=webchat          # any non-empty string; there is no key

# Anthropic-compatible clients (Claude Code, etc.):
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=webchat
```

`./webchat doctor` prints exactly what is installed, what is missing, and what to do
about each missing piece. Run it first whenever something does not work.

## What's in here

- **Master config** — `harness.config.json` turns every feature on or off and
  sets its value in one place. Env var > file > built-in default.
- **Webchat modes** — `generic`, `deepseek`, `chatgpt`, `gemini`, `kimi`,
  `notegpt`, `freebuff`, `claude`. Each carries its own selectors and submit
  quirks. `generic` attempts any webchat outside that list.
- **Model ids that change the webchat's own settings** — every toggle combination
  is published as its own model (`webchat/deepseek/deepthink+search`), so an agent
  picks a model and the harness sets the site's chips before it sends. A toggle that
  only applies to a fresh chat makes the harness summarise the thread, open the new
  chat, and inject the summary as the first message.
- **Configurable system prompt** — set it in the master config, globally or
  per mode. The caller's own system message still wins.
- **Configurable tool-call rounds** — `limits.maxToolRounds` plus
  `limits.wrapUpRounds`, which is how many rounds before the cap the model is
  stopped and asked to deliver its final answer.
- **Auto-continue** — when a webchat pauses a long answer behind a
  *Continue* / *继续* control, the harness clicks it and keeps waiting.
- **Portable paths** — every path resolves from a workspace root or an env
  override. No username, no drive letter, nothing machine-specific.
- **Webchat-mode quirks** — per-site behaviour for the composer clear, the
  submit path, empty phantom rows and busy detection, driven by the mode.
- **Rate-limit cooldown** — a webchat that answers "Messages too frequent" is
  put on a 15-minute cooldown and callers get `429` + `Retry-After` instead of
  retrying into the throttle.
- **Anti-spiral** *(experimental, off by default)* — detects a reasoning loop,
  redirects the model back to the task, and puts a warning at the top of the
  answer if it loops again. Narration-aware.
- **Path-fenced file tools** — `sandbox.js` keeps `read_file`, `write_file`,
  `list_dir` and `run_bash` inside an explicit allowlist of roots.
- **Context handoff** — at the context threshold the model writes a handoff
  document, a new chat opens in the same tab, and the document seeds it.

## Quick start — the `webchat` CLI

Run one command and everything is menu-driven. No file editing, and no need to
remember an environment variable's name.

```bash
./webchat          # or: npm link  →  a global `webchat` command
```

Then:

1. **Webchat & browser** → pick your site.
2. **Launch a browser to log in** → a window opens; sign in yourself.
3. **Check connection** → the CLI probes the tab for the composer (which exists
   only when the page is loaded *and* signed in), shows you what it found, and
   you press one key to confirm.
4. **Open a NEW terminal** and run:

```bash
webchat start
```

That brings the gateway up and offers to launch your agent against it.

### Permission modes

These say **when** the agent is asked, not what it may do:

| Mode | Asks before |
|---|---|
| `manual` | **every** tool call |
| `auto` | **risky** calls only — writes, shell, network. Ordinary reads just run. |
| `yolo` | nothing — never asks |

### Commands

| Command | What it does |
|---|---|
| `webchat` | the interactive configurator |
| `webchat setup` | jump straight to the browser/site screen |
| `webchat start` | start the gateway, then offer to launch your IDE |
| `webchat status` | one-line state of the gateway and browser |
| `webchat logs` | tail the gateway log |
| `webchat doctor` | check the environment and report, with fixes |
| `webchat settings` | open the settings screens directly |

### What the CLI can change

Everything in `harness.config.json`, grouped and described in plain English:
the webchat, the target URL and tab pinning, the bind host/port and advertised
model name, **the gates** (`run_bash`, sandbox on/off, sandbox roots, API token,
command timeout, throttle cooldown), **the tool-call loops** (`maxToolRounds`,
`wrapUpRounds`, request timeout, time-to-first-token grace, context handoff),
agent behaviour (plain-text vs tool mode, narration, anti-spiral), and the
selectors/timings you need when a site changes its DOM.

### The one thing that catches everybody

Every setting resolves with the precedence **environment variable > config file >
built-in default**. So a value set in the environment silently overrides the
file, and editing the file then looks like it did nothing. On a typical install
that is not hypothetical — `WEBCHAT_MODE`, `PORT`, `HOST` and others commonly
live in `harness/.env`, which dotenv loads at boot.

The CLI never hides this. Every screen shows which settings are env-shadowed,
where the shadowing value lives, and what the file says underneath; editing one
offers to remove the shadowing line so the change actually takes effect.

### Where things live

```
<repo>/harness.config.json   the in-clone template
$HARNESS_CONFIG              the real config, often OUTSIDE the clone
<repo>/.env                  loaded by the server at boot; shadows the config
<repo>/.webchat/             pidfiles, logs, and the Chrome profile
```

`webchat doctor` prints the exact config path in use, so there is never a
question of which file you are editing.

### Two notes before you enable anything

`run_bash` is **double-gated**: it needs `features.bashAllowed` *and*
`features.sandboxAllowBash`, and the command must touch only paths inside the
sandbox roots. That fence is a token scan, not a kernel jail — treat it as a
guardrail and run the harness as a user whose files you are willing to lose.

A browser launched by the CLI uses its own profile under `.webchat/`, which is
what makes the login survive a restart. Chrome only exposes a debugging port
when it is given a non-default profile directory, which is why that profile is
not optional.

## Quick start — by hand

Three commands. No editing.

```bash
./scripts/setup.sh                    # asks which webchat, picks a free port, writes .env
./scripts/start.sh                    # the browser opens MINIMISED
./scripts/launch-agent.sh opencode    # or claude | codex | aider | hermes | any
```

That is the whole setup. `setup.sh` is safe to re-run and backs up your `.env`
rather than clobbering it.

**To sign in the first time.** The browser opens minimised on purpose — it is a
real headed browser (headless gets signed out and is a fingerprint tell), just
kept out of your way. Raise it once, sign in, drop it back:

```bash
./scripts/show-window.sh raise      # or: ./scripts/show-window.sh raise && … && ./scripts/show-window.sh drop
```

If you already have a browser open with a signed-in webchat tab, you can attach
to it instead and skip the login entirely:

```bash
./scripts/setup.sh --attach ws://127.0.0.1:9222/devtools/browser/<id>
# (find that id at http://127.0.0.1:9222/json/version)
```

**Check it is alive:**

```bash
curl http://localhost:8080/            # lists every endpoint
curl http://localhost:8080/status      # what tab it is driving
curl -X POST http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-webchat","messages":[{"role":"user","content":"Say hi."}]}'
```

### Pointing a coding agent at it

`launch-agent.sh` does not proxy, fork or wrap your agent. It exports the base
URL and model name that the agent's own provider config already reads, then
`exec`s it — so the agent is a completely normal agent whose "model" happens to
be your logged-in tab.

| Agent | Command | How it is wired |
|---|---|---|
| OpenCode | `./scripts/launch-agent.sh opencode` | writes `./opencode.json` (gitignored) and runs from here |
| Claude Code | `./scripts/launch-agent.sh claude` | `ANTHROPIC_BASE_URL` → `/v1/messages` |
| Codex | `./scripts/launch-agent.sh codex` | `OPENAI_BASE_URL` |
| Aider | `./scripts/launch-agent.sh aider` | `--openai-api-base` passed explicitly |
| Hermes | `./scripts/launch-agent.sh hermes` | exported env |
| anything else | `./scripts/launch-agent.sh any` | prints the four variables; that is the whole surface |

The integration surface is four environment variables:

```
OPENAI_BASE_URL      http://127.0.0.1:8080/v1
OPENAI_API_KEY       any non-empty string (unless you set API_TOKEN)
ANTHROPIC_BASE_URL   http://127.0.0.1:8080
HARNESS_MODEL_NAME   the `model` value from GET /
```

Any tool that lets you set an OpenAI-compatible base URL will work with those.
If your agent is not in the table, `./scripts/launch-agent.sh any` prints them.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /status` | online?, connected?, tool count |
| `GET /tools` | tool schemas (handlers stripped) |
| `GET /v1/models` | model list (for OpenAI-compatible clients) |
| `POST /v1/chat/completions` | OpenAI chat format (accepts `tools` with OpenAI function schema) |
| `POST /v1/messages` | Anthropic messages format (accepts `tools` with `input_schema`) |
| `POST /connect` | (re)connect the browser without a request |

`/v1/messages` with `stream: true` returns the full Anthropic SSE sequence
(live one-line progress per tool execution and per correction, then the final
answer) — clients that require SSE (Claude Code) work against it.
`/v1/chat/completions` accepts `stream: true` and returns a plain JSON body.

## Tool calls

Send the webchat a tool-enabled prompt; the response is scanned for a JSON
object `{"tool":"<name>","params":{...}}` (bare JSON, ```json fences, or
prose-wrapped all work). If found, the tool runs and its result is fed back to
the chat; the loop repeats up to `MAX_TOOL_ROUNDS` times and the final text is
returned.

Built-in tools: `read_file`, `write_file`, `list_dir`, `run_bash`, `search_web`,
`get_time`, `send_message`, `audit_status`, `git_status`, `telegram_send`,
`send_message_to_main`, `send_message_to_antigravity`, `send_telegram_message`,
plus `read_memory` / `edit_memory` (when memory is enabled) and any tools from
attached MCP servers. The model is offered only the **executable** set — a tool
whose requirement is unmet (no `DEEPSEEK_API_KEY`, bash gate off, memory
disabled) is never advertised, so it cannot be tried and looped on.

## Capabilities added 2026-09-22

**Web search without a paid key.** `search_web` no longer hard-requires
`DEEPSEEK_API_KEY`. DeepSeek and Gemini have *native* search in their own UI, so
for those lanes the harness flips the lane's own controls on before a send —
config `webchatModes.<mode>.native.deepThink` / `.search` (DeepSeek chips are
`.ds-toggle-button`, measured live). With no key and no native search, `search_web`
returns one clear "not available on this lane" message instead of a hard error the
model loops on.

**Attach any MCP server.** `harness.config.json` → `"mcp": { "servers": [ { "name",
"command", "args" } | { "name", "url" } ] }`. Tools are discovered over the MCP
protocol and merged into the tool list (names are `<server>.<tool>`). Fail-open:
an unreachable server is skipped and its tools are not advertised. No skills
format exists in this repo, so skills are not wired.

**Tool-result compaction.** `features.toolCompactor` + `compactor.*` thresholds
trim big tool results to head+tail (never an error) before they go back to the
model — the owner's tool-call-compactor rules, re-implemented dependency-free.

**A memory file the user or the model can edit.** `features.memory` (default file
`<workspace>/webchat_memory.md`, `MEMORY_FILE` to move). The model reads/edits it
with `read_memory` / `edit_memory`; the CLI edits it under "Memory contents"; its
contents are included in the system prompt. Capped at `memory.maxChars`.

**Pick the model inside the webchat.** `webchat.model` (or per-mode) selects the
model in the tab's own picker before a send (Gemini: `button[aria-label^="Open
mode picker"]`, measured live). Blank leaves the current selection.

**More loop control.** `limits.maxMalformedRounds` (broken-JSON corrections,
was hardcoded at 3) plus the compactor thresholds above.

**Research-only lane.** `features.noTools` offers the model no work tools (only
`submit_answer`) — pair with `features.allowPlainText` for pure research /
plain-English answers.

**Codex model ids.** Codex rejects slash syntax like `webchat-local/anymodel`.
Point Codex's `model_provider` at this base URL and set `model` to `anymodel` or
`webchat` (or the advertised `model` name) — see `GET /v1/models`.

## 🔒 Sandbox (path fence for every file tool)

`read_file`, `write_file`, `list_dir` and `run_bash` all take paths that come
from a webchat model's output. `sandbox.js` requires every one of them to resolve
inside an explicit allowlist of roots.

```bash
SANDBOX_ENABLED=true                 # default true
SANDBOX_ROOTS=/path/to/project,/path/to/another   # comma-separated allowlist
SANDBOX_ALLOW_BASH=false             # run_bash stays blocked even if BASH_ALLOWED=true
SANDBOX_LOG=true                     # log every denial to stderr
```

`SANDBOX_ROOTS` is also settable as `network.sandboxRoots` in
`harness.config.json`. Adding a root is one comma-separated entry — no code
change. Restart the gateway after editing (config is read once at process
start).

**How it resists escapes**

- Paths are `realpath`-resolved **before** the prefix test, so `..` traversal and
  symlinks pointing outside a root are both rejected.
- A target that does not exist yet (`write_file`) is resolved against its nearest
  existing ancestor, so `foo/../../etc/passwd` still fails.
- The prefix test appends a separator, so `/root/oculus-evil` does **not** match
  the root `/root/oculus`.
- Bash is checked by extracting path-like tokens; any that resolve outside the
  roots denies the whole command.

**Caveat — this is a guardrail, not a jail.** It stops the realistic failure
modes (a confused or prompt-injected model reaching for `~/.ssh` or `/etc`), and
it is not a substitute for running the harness as an unprivileged user. Bash in
particular is checked by token inspection, not by a kernel sandbox — a
sufficiently creative command can still do things the token scan does not
recognise. Keep `SANDBOX_ALLOW_BASH=false` unless you need it.

The same caveat applies to every other control in this harness: the sandbox, the
selector allowlists and the anti-spiral detector are all in-process guardrails.
Run the harness as a user whose files you are willing to lose.

## ⚠️ Safety gates (read before enabling)

1. **`run_bash` is disabled by default, and double-gated.** Even with
   `BASH_ALLOWED=true` the command must also pass the path fence
   (`SANDBOX_ALLOW_BASH=true`), which denies any command touching a path outside
   `SANDBOX_ROOTS`. It is still a token scan, not a kernel jail — treat it as a
   guardrail, not a boundary, and only enable it when you trust the conversation
   content end-to-end. `EXEC_TIMEOUT_MS` (10s default) bounds every command.
2. **Bind to localhost.** `HOST=127.0.0.1` default. If you expose the port,
   set `API_TOKEN` — every request then needs `Authorization: Bearer <token>`.
3. **File tools are path-fenced, not jailed.** `read_file`/`write_file`/
   `list_dir` may only touch paths that resolve inside `SANDBOX_ROOTS`
   (`sandbox.js`, enabled by default). `..` traversal and symlinks out of a root
   are rejected. This is a guardrail against a confused or prompt-injected
   model, not a substitute for running the harness as an unprivileged user.
4. **Automating webchats violates their ToS.** This is for automating chat
   sessions you own and are logged into. Accounts can get rate-limited or
   banned, and providers change their DOM (that's what the selector env vars
   are for). Use at your own risk.

## Integration notes

- **Aider / OpenAI-compatible clients**: `export OPENAI_API_BASE=http://localhost:8080/v1` (or set the equivalent in the client config) and use any model name.
- **Claude Code**: the `anymodel` launcher does it all —
  `anymodel` on this machine checks the API is up, sets
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL=anymodel`, and execs `claude`.
  `/v1/messages` streams the full Anthropic SSE sequence, so Claude Code
  works against it. (The `CLAUDE_API_BASE_URL` env var from the original
  guide does not exist; `ANTHROPIC_BASE_URL` is the real one.)
- **Dual-model gateway** (`server.js`, 2026-08-12): one base URL offers
  BOTH models, so you can switch from inside the Claude Code `/model`
  picker without restarting:

  | model              | route                                        |
  |--------------------|----------------------------------------------|
  | `anymodel`         | the open webchat tab (whatever is logged in) |
  | `deepseek-v4-flash` (or anything else) | proxied verbatim to the upstream API |

  Upstream credentials live in `.env` (`UPSTREAM_ANTHROPIC_BASE_URL`,
  `UPSTREAM_ANTHROPIC_AUTH_TOKEN`, `UPSTREAM_OPENAI_BASE_URL`). Streaming
  requests pass through untouched (`Readable.fromWeb`), so Claude Code's
  required SSE works on both routes. `/v1/models` advertises both ids.
- **Custom model row in the Claude Code `/model` picker** (updated 2026-09-21).
  `ANTHROPIC_CUSTOM_MODEL_OPTION` is the older knob and newer Claude Code
  builds reject an unknown model id from it unless the row declares what it
  behaves as. The current, supported shape is `modelPicker` in **user**
  settings (`~/.claude/settings.json`) — it is deliberately NOT read from a
  project checkout, and only the highest-precedence source that defines it is
  used (no merging):

  ```json
  {
    "modelPicker": {
      "options": [
        {
          "model": "anymodel",
          "label": "Webchat (this machine)",
          "description": "Drives the open webchat tab through the harness",
          "behavesAs": "claude-opus-4-8"
        }
      ],
      "replaceBuiltInOptions": false
    }
  }
  ```

  - `model` is taken **verbatim** — an alias (`opus`), an Anthropic model id,
    or a provider-format id (gateway/Bedrock/Vertex). Same values `--model`
    accepts.
  - `label` / `description` are the row title and subtitle (both optional).
  - `behavesAs` names a model **this build of Claude Code already knows**
    (e.g. `claude-opus-4-8`). Its client-side handling — prompt profile,
    capability and effort defaults — is applied to your id. It changes neither
    the row's label nor the model id sent, so the gateway still receives
    `anymodel`. **Without `behavesAs`, a custom row for a model the build does
    not know is not offered at all**, which is the failure the old advice hit.
  - `replaceBuiltInOptions: true` shows only your rows; `false` appends them to
    the built-ins.
  - Discovery via `/v1/models` is off by default in Claude Code, so a row is
    still the reliable way to make the model selectable.

- **One tab = one conversation.** Requests are serialized through a queue;
  concurrent conversations need separate instances (different `PORT` +
  `WEBCHAT_URL`, own directory).
- **Context handoff** (2026-08-13): the gateway roughly accounts for the
  context it feeds the webchat model in one request (chars/4 ≈ tokens, tool
  sections counted on every round). When the running total crosses
  `CONTEXT_HANDOFF_THRESHOLD` (default `100000`, ≈78% of DeepSeek's 128K
  window), it stops the tool loop, prompts the model to write a complete
  `handoff_to_new_chat.md` document, opens a **new chat** in the same tab,
  and sends the document as its first message. The thread pins are swapped
  automatically (`chat.js` + the supervisor's `WEBCHAT_URL`/`TAB_URL_SUBSTRING`
  line, if present) so respawns follow the new thread; the running instance
  re-targets itself immediately. Disable with `CONTEXT_HANDOFF_ENABLED=false`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8080` | bind address |
| `WEBCHAT_URL` | `https://chat.deepseek.com` | target chat (needs `WEBCHAT_URL_OVERRIDE=true` to take effect when a `chat.js` exists) |
| `WEBCHAT_URL_OVERRIDE` | `false` | `true` makes `WEBCHAT_URL` beat the `chat.js` URL |
| `TAB_URL_SUBSTRING` | *(none)* | attach to the open tab whose URL contains this substring (multi-site instances) |
| `CDP_WS_URL` | *(from `chat.js`)* | attach to an already-running browser via its DevTools ws URL; wins over `chat.js` `cdpWsUrl` |
| `MODEL_NAME` | `deepseek webchat` | model id advertised by `/v1/models`; gateway routes accept `deepseek-v4-pro` / `deepseek-v4-flash` |
| `HEADLESS` | `false` | visible browser for login |
| `TIMEOUT` | `60000` | max wait for a response (ms) |
| `TOOL_CONTEXT_WINDOW` | `8000` | cap on the tools section of the prompt (chars) |
| `MAX_TOOL_ROUNDS` | `40` | max tool-execution rounds per request (also `limits.maxToolRounds`) |
| `WRAP_UP_ROUNDS` | `3` | rounds before that cap at which the model is stopped and told to deliver its final answer (also `limits.wrapUpRounds`) |
| `LOGIN_WAIT_SECONDS` | `300` | how long to wait for manual login |
| `API_TOKEN` | *(none)* | bearer token auth |
| `BASH_ALLOWED` | `false` | enable `run_bash` |
| `EXEC_TIMEOUT_MS` | `10000` | per-command bash timeout |
| `SKIP_BROWSER` | `false` | run server without a browser (testing) |
| `SELECTOR_*` | see `config.js` | comma-separated CSS selector lists, first match wins |
| `VIEWPORT_W` / `VIEWPORT_H` | `0` / `0` | pin the chat viewport (used by multi-site drivers) |
| `BLOCKED_URLS_EXTRA` | *(none)* | extra URL globs to block at the network layer (comma-separated) |
| `BLOCKED_CSS` | `false` | `true` also blocks all `*.css*` (DeepSeek-only — other layouts break without stylesheets) |
| `CONTEXT_HANDOFF_ENABLED` | `true` | auto-swap to a new chat at the context threshold |
| `CONTEXT_HANDOFF_THRESHOLD` | `100000` | rough per-request context estimate that triggers the handoff (chars/4 ≈ tokens) |
| `WEBCHAT_MODE` | `generic` | webchat mode: generic / deepseek / chatgpt / gemini / kimi |
| `SYSTEM_PROMPT` | *(none)* | override the configured system prompt |
| `IGNORE_CLIENT_SYSTEM` | `false` | drop the caller's own system message entirely — only the harness prompt is sent (see below) |
| `HARNESS_CONFIG` | `./harness.config.json` | path to a different master config file |
| `HANDOFF_FILE` | `<workspace>/handoff_to_new_chat.md` | where the handoff document is written |
| `WORKSPACE_ROOT` | the harness's parent directory | base for every default path (audits, handoff, sibling repos) |
| `RATE_LIMIT_COOLDOWN_S` | `900` | seconds to cool a webchat after a "Messages too frequent" throttle |
| `RATE_LIMIT_GUARD` | `true` | set `false` to disable the rate-limit detector |
| `ANTI_SPIRAL` | `false` | `true` enables reasoning-loop detection (see below) |
| `ANTI_SPIRAL_MIN_WORDS` | `40` | don't judge a reply shorter than this |
| `NARRATION` | `false` | `true` lets the model narrate; also relaxes anti-spiral so narration is never mistaken for a loop |

### Webchat modes

Every webchat needs slightly different selectors and submit behaviour. Pick one
with `webchat.mode` in `harness.config.json`, or the `WEBCHAT_MODE` env var.

| mode | site | input selector | message selector | notable quirks |
|---|---|---|---|---|
| `generic` | — | `(default)` | `(default)` | — |
| `deepseek` | https://chat.deepseek.com | `textarea` | `.ds-markdown, .message` | clickFallbackOnFullComposer, autoContinueButton |
| `chatgpt` | https://chatgpt.com | `#prompt-textarea` | `[data-message-author-role="assistant"]` | clickFallbackOnFullComposer, autoContinueButton, skipEmptyMessageRows, ignoreStopButtonWhileBusy |
| `gemini` | https://gemini.google.com | `div[contenteditable="true"], rich-textarea .ql-editor` | `model-response, .model-response-text` | enterSubmits, phantomStopButton |
| `kimi` | https://www.kimi.ai/chat | `.chat-input-editor` | `.chat-content-item-assistant` | clearComposerWithKeyEvents, enterSubmits, clickFallbackOnFullComposer, autoContinueButton, restoresSavedDraft |
| `notegpt` | https://notegpt.io/ai-chat | `div[contenteditable="true"]` | `.markdown-body` | send-in-page only; composer holds a stale draft |

Anything you set explicitly still wins: an explicit `webchat.url`,
`webchat.selectors.*` or the matching `SELECTOR_*` env var overrides the mode.
An unknown mode name falls back to `generic` and logs a warning — it never
crashes.

These six are the TESTED modes: `deepseek`, `chatgpt`, `gemini`, `kimi`,
`notegpt`, plus `generic`. Each one works differently — different composer,
different send behaviour, different answer node — which is why they are modes
and not one code path.

`generic` attempts to work with any webchat outside that list: it uses broad
selectors and the default submit behaviour. It will get you connected, but a
site with a custom composer may need its own mode.

If your webchat does not work with `generic`, open an issue and it will get a
dedicated mode.

### System prompt

`harness.config.json` → `systemPrompt`:

```json
{
  "systemPrompt": {
    "mode": "",
    "text": "",
    "perMode": { "generic": "", "deepseek": "", "chatgpt": "", "gemini": "", "kimi": "" }
  }
}
```

- `perMode[mode]` wins over `text`.
- An empty string means "use the harness's built-in prompt".
- The `SYSTEM_PROMPT` env var overrides both.
- A system message sent by the API caller still takes precedence — the caller's
  own contract is never replaced.

#### `IGNORE_CLIENT_SYSTEM` — for agent callers (2026-09-16)

Callers differ in what their system message is worth. A raw API client sends a
task contract the model should follow. A **coding agent** (opencode, Claude
Code, Aider) sends *its own* system prompt — tens of KB of rules about its own
tools, its own permission model and its own output format, none of which exist
inside a webchat tab. It does not just waste tokens: it is a second, competing
contract, and the model follows whichever it read last.

With `features.ignoreClientSystem: true` (or `IGNORE_CLIENT_SYSTEM=true`) the
caller's system message is dropped and **only** the harness prompt is sent.
The caller's tool list is already ignored — `buildExecutableToolDefs()`
substitutes the harness's own tools — so this closes the last channel through
which an agent's harness leaks into the webchat.

```json
{ "features": { "ignoreClientSystem": true } }
```

Pairs with a `systemPrompt.text` carrying whatever the worker should actually
be told. Verified: sending a system message containing a marker string leaves
no trace of it in the tab.


### Master config — `harness.config.json`

Every feature can be turned on or off, and given a specific value, in **one
file** at the repo root instead of hunting through systemd drop-ins:

```json
{
  "features": {
    "narration": false,
    "antiSpiral": false,
    "contextHandoff": true,
    "allowPlainText": false,
    "bashAllowed": false,
    "sandbox": true
  },
  "limits": {
    "timeoutMs": 1800000,
    "maxToolRounds": 40,
    "contextHandoffThreshold": 2000000
  },
  "paths": {
    "workspaceRoot": "",
    "auditsPlansDir": ""
  }
}
```

**Precedence, highest first:**

1. an environment variable — `ANTI_SPIRAL=true node server.js`
2. `harness.config.json`
3. the built-in default documented in the table above

So the file is a baseline and a per-instance env var (or a systemd drop-in)
still overrides it. Every key is optional; a missing or malformed
`harness.config.json` is ignored and the harness behaves exactly as before.
Point `HARNESS_CONFIG` at a different file to use a second config.

An empty string (or `""`) in the file means "not configured" and falls back to
the default — it never blanks out a real value.

## ⏳ Rate-limit cooldown

A webchat account throttles you for sending too fast and answers with
**"Messages too frequent. Try again later."** (DeepSeek; `finish_reason:
rate_limit`). The harness used to read that as a normal empty reply, so the
caller retried immediately, got throttled again, and burned its whole round
budget on a lane that could not answer.

Now the gateway:

1. **detects** the throttle notice in a reply — or in a thrown send error,
2. puts **that account** on a flat cooldown (`RATE_LIMIT_COOLDOWN_S`, default
   **900s = 15 min**), and
3. answers **`429` + `Retry-After`** while the cooldown is in force, so a caller
   fails fast and moves to another lane instead of hanging.

The cooldown is per **account** (the same lock key the gateway already uses), so
the DeepSeek accounts never cool each other. It is persisted to a small JSON file
in `RATE_LIMIT_STATE_DIR` (default: the OS temp dir, `os.tmpdir()`), so a gateway
restart does not forget a live throttle. A real answer clears it.

Detection is deliberately tight: only the notice's own words
(`messages too frequent`, `too many requests`, `rate_limit_reached`,
`free_rate_limited`, `发送太频繁`), only in the first 160 characters, and only in
a reply under 300 characters. A loose `/rate limit/i` matched a genuine answer
about rate-limiting middleware, which is why it is anchored.

## Concurrency, locking and the fresh-chat reset (updated 2026-09-21)

**Lock files are built with `os.tmpdir()`, not a hardcoded `/tmp`.** On Windows
`/tmp` resolves to `C:\tmp`, which usually does not exist — `mkdirSync` then
failed with `ENOENT`, the old blanket `catch` read *any* failure as "another
gateway holds the lock", and every request waited out the full
`DEEPSEEK_LOCK_TIMEOUT_MS` before erroring. That looked exactly like a hang:
nothing ever reached the composer.

The mutex now:

1. creates the lock **parent** first (`mkdirSync(dirname, {recursive:true})`), so
   a missing parent can never be mistaken for a held lock;
2. treats **only `EEXIST`** as "someone else holds it" — `ENOENT`, `EACCES`,
   `EPERM`, `ENOSPC`, `EROFS` and `ENOTDIR` all raise a named error immediately
   (`webchat mutex: cannot create lock <path> (<code>: <message>)`) instead of
   being waited out;
3. does the same for the shared send-spacing file.

Override the location with `WEBCHAT_LOCK_DIR` / `SEND_SPACING_FILE` /
`RATE_LIMIT_STATE_DIR` if the temp dir is not where you want them.

**The automatic fresh-chat reset now only runs at a request boundary.** The
thread has to be recycled eventually — an unbounded webchat thread grows until
the renderer dies (measured on chatgpt: 144 rows / ~429 KB of DOM → `Target
closed`). But the counter used to be incremented *and acted on* inside
`countedSend()`, which fires for every internal send: tool-loop corrections,
tool-result follow-ups, format repairs. A multi-tool request could therefore hit
the threshold **mid-response**, call `openNewChat()`, navigate the tab away from
the live conversation and break the tool loop — surfacing in Claude Code as
`API Error: Server error mid-response`.

So the count is still taken on every send, but the swap happens once, before the
next client request starts, and never while one is in flight. The tradeoff: a
single very long request (many tool rounds) will no longer be broken up by a
reset, so the thread can grow larger within one request than it used to. In
exchange the tab is never navigated out from under a running tool loop. Set
`NEW_CHAT_EVERY_SENDS=0` to disable automatic resets entirely (the manual
`POST /newchat` still works); the context-handoff flow is unaffected either way.

Regression tests for both behaviours live in `harness_tests/mutex_and_reset.test.js`
(Node's built-in runner, no extra dependencies) and are run with `npm test`.

## 🧪 EXPERIMENTAL — Anti-spiral (`ANTI_SPIRAL=true`)

> **Experimental.** Off by default and not enabled in the author's own
> deployment — no genuine benefit has been observed there yet. Turn it on if you
> are seeing reasoning loops. See also `harness.config.json`.

A webchat model can collapse into a reasoning loop — the same sentence, line, or
a short `Let me go.` / `Let me read.` tic repeated until the round budget runs
out. The caller then gets `did not submit a final answer within the round budget`
and all the work is lost.

With `ANTI_SPIRAL=true` the gateway watches each reply for five loop signatures
(ported from the opencode anti-spiral plugin v3, which was tuned against real
spirals):

1. the same sentence (>30 chars) twice in a row
2. the same prose line (>= 6 words) three or more times
3. the stall tic — a <= 4-word line (`Let me go.`, `OK.`) on its own, 4+ times
4. n-gram dominance over the whole message
5. tail dominance — the END of the message degenerated into one unit

Code fences, tables and tool output are stripped before measuring, because those
repeat lines legitimately.

On the **first** detection the gateway stops feeding the tab and sends one
redirect back into it — *stop repeating yourself, emit exactly one tool call*.
On a **second** detection it stops the turn and returns the model's text with a
warning at the top:

```
🛑 [ANTI-SPIRAL] Generation stopped: <what looped>. The loop was cut and the
model was told to stop narrating and do the work. Partial work may be
incomplete — re-send to continue.
```

### Narration is not a spiral

If you drive this harness as an IDE agent you want narration — the model saying
*"Let me run list_dir to inspect…"* before each tool call. That line repeats by
design, once per tool call.

So `NARRATION=true` also relaxes the detector: the `Let me …` tic fast-path is
dropped, the repetition bars are raised, and the sentence check needs a much
longer sentence. With narration **off** the model is meant to emit only tool
JSON, so repeated prose is a loop and the sensitive thresholds apply.

Verified: a real `Let me run list_dir…` loop trips in both modes; a 14-line
narrated IDE session trips in neither.

## Performance & resource tuning (2026-08-14)

The webchat tab is the stack's dominant memory/CPU consumer. The harness
ships two knobs to strip it down, plus a lean launch profile for the Chrome
it drives.

**Network-level asset blocking.** On attach the driver installs
`Network.setBlockedURLs` and drops media/font blobs before they ever render.
Chrome never downloads or decodes them — a chat tab that idled at hundreds of
MB of decoded images stays at a few tens.

- Always on: `*.png *.jpg *.jpeg *.gif *.webp *.avif *.svg *.ico *.woff
  *.woff2 *.ttf *.otf *.mp4 *.mp3 *.webm`
- `BLOCKED_CSS=true` additionally blocks all `*.css*` (DeepSeek-only; the
  Gemini/ChatGPT layouts break without stylesheets)
- `BLOCKED_URLS_EXTRA='*.js*,*.json*'` strips scripts too for a pure-text
  head — nothing else on the page works, diagnostics only
- Verify at attach time: the gateway logs `🚫 Asset blocking ON (N patterns)`

**Lean Chrome launch profile** (persistent-CDP mode):

```bash
--disable-gpu --disable-dev-shm-usage --disable-background-networking \
--disable-sync --disable-translate --metrics-recording-only --mute-audio \
--js-flags=--max-old-space-size=512
```

The first three are the memory/CPU wins; the rest stop telemetry, sync and
audio churn. Headless instances add `--headless=new --no-sandbox` with a
spoofed UA. Verify a live instance with `tr '\0' ' ' < /proc/<pid>/cmdline`.

**Multiple sites = multiple drivers.** This box runs two persistent Chrome
instances: a GUI one (port 9223, watch window) and a `--headless=new` one
(port 9224). Gemini attaches to the **headless** instance — the GUI instance
cannot generate responses (a client-side, pre-network failure reproduced on
fresh tabs; see the ops guide). Each gateway targets its own tab via
`TAB_URL_SUBSTRING`, so one driver serves several chats.

See **`docs/OPERATIONS_AND_PERFORMANCE.md`** — the full instruction guide:
architecture (gateways / tabs / drivers), env reference, send-flow internals,
context handoff, and troubleshooting recipes.

## Troubleshooting

| Issue | Fix |
|---|---|
| UI changed / selectors stale | set `SELECTOR_INPUT`/`SELECTOR_SEND`/`SELECTOR_MESSAGE` in `.env` |
| CAPTCHA appears | solve it in the browser window; the poll keeps waiting |
| Tool call not recognized | check the response shape — parser needs a balanced `{"tool","params"}` block |
| Rate limited | rotate `WEBCHAT_URL` between chats, or run several instances |
| Browser crashed | restart the server; cookies make reconnect painless |
| `API Error: Stream idle timeout - no chunks received` / tab goes quiet mid-turn | **known issue, see below** — the webchat SSE stream died mid-generation; restarting the gateway is NOT enough, reload the tab (recovery below) |

## ⚠️ Known issue: stream idle timeout / wedged tab (2026-08-15)

**Symptom.** A request errors with `API Error: Stream idle timeout - no chunks
received`, the gateway logs `⚠️ upstream stream error (mid-SSE reset):
terminated`, and the tab goes quiet: it stops generating mid-turn, never
finishes, and every subsequent send queues behind the dead in-flight
exchange. Restarting the gateway process does **not** help — a fresh instance
re-attaches to the *same frozen tab* and wedges again within minutes.

**Root cause.** The webchat frontend's SSE stream died while a generation was
in flight. The tab's page state still believes it is mid-generation, so the
gateway's send mutex stays locked ("waiting for the in-flight message") and
the queued send — including any `injectMainReplies` payload that was already
stamped as seen — never reaches the tab. The tab itself is *idle*, not busy.

**Diagnosis.** Via CDP (the browser exposes `/json/list`): if the tab's DOM
has **no stop button** (`document.querySelector('[class*="stop"]')`), the tab
is NOT generating — it is wedged. Check the gateway log for `mid-SSE reset`
or `stream idle timeout`.

**Recovery (in order).**

1. **Reload the tab** — the thread history is server-side, nothing is lost:
   connect to the tab's `webSocketDebuggerUrl` (WebSocket, send
   `suppress_origin=true` — Chrome rejects cross-origin CDP sockets
   otherwise) and issue `Page.reload`. Wait for the chat input to be found
   (`✅ Chat input found — logged in.`).
2. **Restart the gateways** by PID (`kill <pid>`) so they re-attach to the
   reloaded tab. Never `pkill -f` — several unrelated processes match.
3. **Re-stamp lost queue entries.** `injectMainReplies` advances its
   seen-marker (`.main_reply_seen_<PORT>.json`) when it *builds* the block —
   if that send then dies in the mutex queue, the entries were marked seen
   but never delivered. Bump each undelivered entry's `ts` in the outbox
   JSON to a fresh value > the marker, and pre-arm the OTHER gateway's marker
   to the same value if two gateways share one thread (filter is
   strictly-greater, so equal never re-injects — this prevents a duplicate
   dump from the second gateway).
4. Verify with a tiny round-trip: a `/v1/chat/completions` request asking for
   `PONG`. A `PONG` response through the reloaded tab proves the chain is
   healthy; the next real send then carries the re-stamped entries.

**Prevention.** Keep the send mutex and wedge-guard (restarts silent
listeners) — they are correct. The missing piece is tab-level self-healing:
when a stream dies mid-turn, the tab must be reloaded, not just the gateway.

---

## 🔗 Companion Repositories & Toolchain Dependencies

2. **[`Insane-Custum-Claude-Settings`](https://github.com/ronisaguey-ux/Insane-Custum-Claude-Settings.git)**:
   - Universal Claude Code settings, PreToolUse banned action hooks, and slash commands.
