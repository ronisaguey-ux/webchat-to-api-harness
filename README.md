# Webchat-to-API Converter

**Note:** This harness is best used with DeepSeek webchat (chat.deepseek.com). It is the primary target and most thoroughly tested.

An OpenAI- **and** Anthropic-compatible API backed by a real webchat tab
(DeepSeek, ChatGPT, Claude.ai, …) driven with Puppeteer. Lets any agentic
wrapper (Aider, LiteLLM clients, Claude Code via `ANTHROPIC_BASE_URL`) talk to
a webchat session you own, with tool-call support (read/write files, bash, …).

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


## Quick start

bash
npm install
cp .env.example .env
cp chat.js.example chat.js   # chat.js is gitignored — it holds YOUR thread URL
# ⭐ edit chat.js — paste the URL of your webchat tab there. That's it.
./start.sh                    # visible browser opens → log in once


First request connects lazily; with `HEADLESS=false` a browser window opens and
you log in manually (session cookies are saved to `.cookies.json` and reused on
later starts). The server polls for the chat input box instead of blocking on
stdin, so it works fine under systemd/tmux.

**Optionally reuse the tab you already have open**: launch your browser with
`--remote-debugging-port=9223`, put the printed ws URL in `chat.js` under
`cdpWsUrl`, and the server drives *your existing tab* — no login at all.

bash
curl http://localhost:8080/status
curl -X POST http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Write a short essay about the history of Rome."}]}'


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
object `{"tool":"<name>","params":{...}}` (bare JSON,  fences, or
prose-wrapped all work). If found, the tool runs and its result is fed back to
the chat; the loop repeats up to `MAX_TOOL_ROUNDS` times and the final text is
returned.

Built-in tools: `read_file`, `write_file`, `list_dir`, `run_bash`, `search_web`
(placeholder). Custom tools = add entries to `TOOL_DEFINITIONS` in `tools.js`.

## ⚠️ Safety gates (read before enabling)

1. **`run_bash` is disabled by default and MUST remain disabled unless the environment is explicitly hardened.** The webchat model's output is parsed
   and executed **verbatim** with no sandbox — a prompt-injected page or a
   hostile response can run anything on this machine. If you must enable it,
   set `BASH_ALLOWED=true` **only** after deploying a container/nsjail with an
   allowlist, command audit logging, and network restrictions. `EXEC_TIMEOUT_MS`
   (10s default) bounds every command.
2. **Bind to localhost.** `HOST=127.0.0.1` default. If you expose the port,
   set `API_TOKEN` — every request then needs `Authorization: Bearer <token>`.
3. **File tools are unsandboxed.** `read_file`/`write_file` accept absolute
   paths. The model gets whatever path it asks for.
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
  required SSE works on both routes. `/v1/models` advertises both ids. To
  surface a custom id as a row in the Claude Code picker, set
  `ANTHROPIC_CUSTOM_MODEL_OPTION=anymodel` (+ `_NAME`/`_DESCRIPTION`) —
  discovery via `/v1/models` is off by default in Claude Code.
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
| `CLOAKBROWSER` | *(off)* | `1` swaps puppeteer for CloakBrowser (stealth Chromium v146, github.com/CloakHQ/CloakBrowser) — source-level fingerprints pass Google's session-rotation challenge that vanilla puppeteer trips (fake UA + ephemeral profile + saved cookies). Used by the gemini lane (08-21, VERIFIED PONG). Requires `cloakbrowser` + `playwright-core` npm deps; env-gated, all other lanes unaffected. |
| `TIMEOUT` | `60000` | max wait for a response (ms) |
| `TOOL_CONTEXT_WINDOW` | `8000` | cap on the tools section of the prompt (chars) |
| `MAX_TOOL_ROUNDS` | `4` | max tool-execution rounds per request |
| `LOGIN_WAIT_SECONDS` | `300` | how long to wait for manual login |
| `API_TOKEN` | *(none)* | bearer token auth |
| `BASH_ALLOWED` | `false` | enable `run_bash` — **must remain `false` unless container/nsjail + audit logging are in place** |
| `EXEC_TIMEOUT_MS` | `10000` | per-command bash timeout |
| `SKIP_BROWSER` | `false` | run server without a browser (testing) |
| `SELECTOR_*` | see `config.js` | comma-separated CSS selector lists, first match wins |
| `VIEWPORT_W` / `VIEWPORT_H` | `0` / `0` | pin the chat viewport (used by multi-site drivers) |
| `BLOCKED_URLS_EXTRA` | *(none)* | extra URL globs to block at the network layer (comma-separated) |
| `BLOCKED_CSS` | `false` | `true` also blocks all `*.css*` (DeepSeek-only — other layouts break without stylesheets) |
| `CONTEXT_HANDOFF_ENABLED` | `true` | auto-swap to a new chat at the context threshold |
| `CONTEXT_HANDOFF_THRESHOLD` | `100000` | rough per-request context estimate that triggers the handoff (chars/4 ≈ tokens) |
| `HANDOFF_FILE` | `/home/roni/Roni_workspace/handoff_to_new_chat.md` | where the handoff document is written |

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

bash
--disable-gpu --disable-dev-shm-usage --disable-background-networking \
--disable-sync --disable-translate --metrics-recording-only --mute-audio \
--js-flags=--max-old-space-size=512


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

1. **[`drift-clean`](https://github.com/ronisaguey-ux/drift-clean.git)**:
   - Provides background session hygiene, stream drift monitoring, and multi-AI transcript cleanup.
2. **[`Insane-Custum-Claude-Settings`](https://github.com/ronisaguey-ux/Insane-Custum-Claude-Settings.git)**:
   - Universal Claude Code settings, PreToolUse banned action hooks, and slash commands.
3. **[`helpotron`](https://github.com/ronisaguey-ux/helpotron.git)**:
   - Full-stack agentic workspace and reactive testing framework.

---

## Shannon / pi-coding-agent compatibility (09-04)

The gateways speak two dialects to AI pentest agents:

- `/v1/chat/completions` — classic OpenAI shape (SSE stream when `CHAT_COMPLETIONS_SSE=1`);
- `/v1/responses` — the Responses dialect used by pi-coding-agent
  (the worker runtime of Keygraph Shannon). Enables a **free webchat account
  as the model backend for @keygraph/shannon**:

export SHANNON_AI_MODEL="openai:anymodel"
export SHANNON_AI_BASE_URL="http://<host>:<port>/v1"   # this gateway
export SHANNON_AI_API_KEY="anything"                    # gateways don't auth


### Tool protocol (so the lane model can drive tool calls)

1. Schema injection — the request's tool names+schemas are serialized into the
   lane prompt (all tools by default; `TOOL_SCHEMA_SLICE=N` caps it).
2. Call-first — the format text instructs the model to open every tool-requiring
   reply with `CALL_TOOL: <name> <json>` (toggle: `CALL_FIRST=1`).
3. The bridge converts that line to a real `function_call` item mid-stream, so
   the pi worker executes the call and feeds the result back.
4. Prose fallback — a queue-shaped JSON object inside a prose reply is upgraded
   to a `function_call` (`JSON_TEXT_FALLBACK=1`).
5. Thinking-head guard — short gemini "Analyzing..." headings are never taken
   as answers (`THINKING_HEAD_GUARD`, default on).

### Modes / feature toggles (all env, documented in `.env.example`)

`RESPONSES_BRIDGE` · `CHAT_COMPLETIONS_SSE` · `CALL_FIRST` · `TOOL_SCHEMA_SLICE`
· `JSON_TEXT_FALLBACK` · `THINKING_HEAD_GUARD` · `MAX_TOOL_ROUNDS` ·
`FORMAT_ERROR_ROUNDS` · `MIN_LANE_GAP_SECONDS` · `SAVE_COOKIES` ·
`COLLAPSE_REPLIES` · `INSTANT_SWAP_EXPERT`/`FORCE_EXPERT` · `USER_AGENT_OVERRIDE`
· `FINGERPRINT_PLATFORM`

### Browser modes

- **Own headless (default)** — the gateway launches its own stealth Chromium
  (`CLOAKBROWSER=1`, profile via `WEBCHAT_PROFILE`).
- **CDP attach** — use a browser you own/control (e.g. a logged-in Desktop
  Chrome): `CDP_WS_URL=ws://127.0.0.1:9223/devtools/browser/x`
  (placeholder id; the live id is resolved from `/json/version`). Session
  survival matters — antidetect fingerprints get flagged by Google across
  accounts; the user's own browser does not.

### Debug routes (dev)

`GET  /debug/dump` — page URL + body text + screenshot length.
`POST /debug/eval {"code":"..."}` — run JS in the tab.
