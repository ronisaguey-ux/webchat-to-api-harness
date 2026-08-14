# webchat-api — Operations & Performance Guide

Companion to the README. This is the "how it actually runs" document: the
multi-gateway layout, the Chrome drivers, the knobs that keep the stack fast
and light, the internals of the send flow and context handoff, and the
troubleshooting recipes that took a while to learn. Current as of 2026-08-14.

---

## 1. Architecture

```
  Claude Code / Aider / any wrapper
      │  (one base URL, many model rows)
      ▼
  gateways — one `node server.js` per chat, each a separate process
  ┌────────────────────────────────────────────────────────────────┐
  │ 8080 personal   8081 telegram   8082 orchestrator               │
  │ 8083 qwen       8084 kimi       8085 gemini                     │
  └──────────────┬─────────────────────────────────────────────────┘
                 │ puppeteer.connect(CONFIG.cdpWsUrl)
                 ▼
  persistent Chrome instances (remote-debugging ports)
  ┌──────────────────────────────┬────────────────────────────────┐
  │ 9223 — GUI, DISPLAY=:1       │ 9224 — --headless=new          │
  │ profile: gc-cdp              │ profile: gc-cdp-hl (copy)      │
  │ qwen, kimi tabs              │ deepseek tabs, gemini          │
  └──────────────────────────────┴────────────────────────────────┘
```

Key idea: **the browser outlives the gateways.** Each gateway attaches to an
already-running Chrome via its DevTools websocket URL (`CDP_WS_URL`, from
`chat.js` or the environment) and drives *one specific tab* — the one whose
URL matches `TAB_URL_SUBSTRING`. Gateways die and respawn; the tabs (and their
logins) never do.

### One tab = one conversation

Requests are serialized through a per-gateway queue. Concurrent conversations
need separate instances: different `PORT`, different `WEBCHAT_URL` /
`TAB_URL_SUBSTRING`, own directory. A supervisor script (see §9) keeps every
gateway alive, re-derives the `CDP_WS_URL` after a Chrome restart, and pins
each chat's tab so respawns land on the right thread.

### Why two Chrome instances?

- **9223 (GUI)** — real window on `DISPLAY=:1`, a real profile, keeps the
  watch window and hosts the qwen/kimi tabs.
- **9224 (headless)** — `--headless=new` with a **copy** of the profile,
  hosts the deepseek threads and gemini. Headless instances use far less
  memory and run on the same login.

---

## 2. Chrome launch profile

Launch args used on both drivers (persistent-CDP mode):

```bash
--disable-gpu --disable-dev-shm-usage --disable-background-networking \
--disable-sync --disable-translate --metrics-recording-only --mute-audio \
--js-flags=--max-old-space-size=512
```

| Flag | What it buys |
|---|---|
| `--disable-gpu` | no GPU process, no compositor threads |
| `--disable-dev-shm-usage` | `/dev/shm` is tiny in containers; without this Chrome crashes |
| `--disable-background-networking` | no background throttler/telemetry traffic |
| `--disable-sync --disable-translate` | no account sync, no translate service |
| `--metrics-recording-only` | no UMA/metrics upload |
| `--mute-audio` | no audio service for a page that plays nothing |
| `--js-flags=--max-old-space-size=512` | cap the V8 heap so a leaked tab can't eat the box |

The 9224 headless instance adds `--headless=new --no-sandbox` and a spoofed
desktop UA (some webchats refuse headless UAs).

**Verify a live instance** (the flags are real — this is how you check):

```bash
tr '\0' ' ' < /proc/$(pgrep -f 'remote-debugging-port=9224' | head -1)/cmdline
```

---

## 3. Asset blocking

On attach, `browser.js` calls `Network.enable` + `Network.setBlockedURLs`
with `config.blockedUrls`, then logs `🚫 Asset blocking ON (N patterns)`.
Blocked requests are aborted in the network layer — Chrome never downloads or
decodes them.

**Default patterns** (always on): images, video, audio, svg, icons, webfonts:

```
*.png* *.jpg* *.jpeg* *.gif* *.webp* *.avif* *.svg* *.ico*
*.woff* *.woff2* *.ttf* *.otf* *.mp4* *.mp3* *.webm*
```

**Configuration:**

| Env var | Effect |
|---|---|
| `BLOCKED_URLS_EXTRA='a,b'` | append extra globs (comma-separated) |
| `BLOCKED_CSS=true` | also block all `*.css*` |

> **CSS is DeepSeek-only.** The Gemini and ChatGPT layouts fall apart without
> stylesheets (overlapping panels, unusable composer). `BLOCKED_CSS=true` is
> set only on the deepseek gateways.
>
> `BLOCKED_URLS_EXTRA='*.js*,*.json*'` additionally strips scripts — pure-text
> head, **nothing works on the page**, diagnostics only.

**Verify the block is live:** attach with a CDP client and check the log line,
or watch the Network events — media requests come back as `canceled`.

---

## 4. Gemini setup (3.7 Flash)

Gemini runs on the **headless** driver (9224), not the GUI one. Gateway:

```bash
PORT=8085
MODEL_NAME='gemini 3.7 flash webchat'
CDP_WS_URL='ws://127.0.0.1:9224/devtools/browser/<id>'   # from /json/version
```

- Model chip label: `Open mode picker, currently Flash` = 3.7 Flash active.
- Responses include `reasoning_content` and `usage.reasoning_tokens` —
  reasoning is on.
- **The GUI (9223) instance cannot generate.** Reproduced across four error
  variants, clean 30-char prompts, fresh tabs, and with the asset blocker
  disabled (A/B): the failure is client-side and pre-network — zero request
  traffic, zero JS errors, garbage/echo text on fresh tabs. Not the flags
  (9224 runs the same ones). Don't debug it again — use 9224.

### Why the send flow needed a fix

Gemini's composer is a rich editor: programmatic `el.focus()` doesn't fully
activate it, so Enter is ignored. And the generic
`div[role="button"]` send-button fallback can land on the **model-picker
chip** instead of the send button (observed: picker menu opened mid-send,
text stuck in the composer).

`browser.js` `sendMessage()` therefore does, for non-DeepSeek hosts: scroll
into view → `page.mouse.click` on the **composer center** (trusted, real
input event) → wait → then proceed with the normal flow. DeepSeek keeps its
fast path.

---

## 5. Send-flow internals

The full send path (all sites):

1. Wait for the chat input (`config.selectors.input`, first match wins).
2. Scroll into view + `el.focus()` (page-level evaluate — JSHandle-arg
   evaluations hang after an input remount; never evaluate with handles).
3. Non-DeepSeek hosts: trusted `page.mouse.click` on the composer center
   (see §4), small settle delay.
4. **Never-send-empty guard** — if the composer holds no text, abort.
5. `installStreamTee` before sending — see §6.
6. Trusted `page.keyboard.press('Enter')`.
7. `stillFull` re-check; if the text is still in the composer, fall back to a
   coordinate click on the real send button (resolved from the selector
   list, with a STOP-morph guard: if the element stopped matching the
   DeepSeek glyph check mid-flow, don't click).
8. Wait for stable response text (`SELECTOR_MESSAGE`), then read it.

Why coordinates, not `elementHandle.click()`: handles detach after DOM
remounts mid-typing (the observed hang), and generic role-based fallbacks hit
toolbar chips. Trusted CDP-level input with geometry computed fresh per step
is the reliable path.

---

## 6. Stream tee (how responses are read)

Headless Chrome doesn't commit assistant rows to the DOM in the same way as a
visible browser, so the gateway reads the **completion XHR stream** the
webchat page itself makes (installed before send):

- `APPEND` patches → partial answer text
- bare `{"v": …}` chunks → progress/skip
- status `SET FINISHED` → done

The DOM stays as a fallback for sites that don't emit the stream. Parser
handles both formats. For Claude Code clients the gateway re-emits the full
Anthropic SSE sequence live, so streaming works end-to-end.

---

## 7. Context handoff

DeepSeek's window is 128K tokens (~500K chars ≈ 2000000 char threshold). The
gateway counts the chars it actually feeds the model in one request
(measured on the real request body via a `tee` capture, not estimated) and
applies gates:

1. **Pre-send**: running estimate ≥ `CONTEXT_HANDOFF_THRESHOLD` (default
   `2000000`) → stop the tool loop, write `handoff_to_new_chat.md` (a
   complete summary the model writes itself), **open a new chat in the same
   tab**, send the document as the first message.
2. **Round-top growth**: if a single request round grows the estimate by
   more than ~8K chars, count it toward the threshold.
3. **Safety net**: a real `context_length_exceeded` error from the webchat
   also triggers the handoff path.

After the swap the thread pins are updated (`chat.js` and the supervisor's
`WEBCHAT_URL`/`TAB_URL_SUBSTRING`), so respawns follow the new thread; the
running instance re-targets immediately. Disable with
`CONTEXT_HANDOFF_ENABLED=false`.

---

## 8. Models, validation, routing

Gateways accept only two model names — `deepseek-v4-pro` and
`deepseek-v4-flash`; anything else is rejected with
`The supported API model names are deepseek-v4-pro or deepseek-v4-flash`.
This keeps Claude Code's `/model` picker rows pointing at real routes.

A multi-model setup uses `WEBCHAT_ROUTES` (a single base URL, several model
rows, each routed to a different gateway/tab — e.g. one slot per webchat
site) and per-site `SELECTOR_*` overrides in `browser.js`. Foreign model ids
sent to the wrong gateway are rejected rather than silently proxied.

---

## 9. Env var reference

| Env var | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8080` | bind address |
| `WEBCHAT_URL` | `https://chat.deepseek.com` | target chat (needs `WEBCHAT_URL_OVERRIDE=true` when a `chat.js` exists) |
| `WEBCHAT_URL_OVERRIDE` | `false` | `true` makes `WEBCHAT_URL` beat the `chat.js` URL |
| `TAB_URL_SUBSTRING` | *(none)* | attach to the open tab whose URL contains this substring |
| `CDP_WS_URL` | from `chat.js` | DevTools ws URL of the running browser (wins over `chat.js`) |
| `MODEL_NAME` | `deepseek webchat` | model id advertised by `/v1/models` |
| `HEADLESS` | `false` | visible browser for first-time login |
| `ALLOW_PLAIN_TEXT` | `false` | tolerate plain-text answers (no JSON fence) |
| `VIEWPORT_W` / `VIEWPORT_H` | `0` / `0` | pin the chat viewport (multi-site drivers) |
| `BLOCKED_URLS_EXTRA` | *(none)* | extra network-block globs, comma-separated (§3) |
| `BLOCKED_CSS` | `false` | block all `*.css*` (DeepSeek only) |
| `TIMEOUT` | `1800000` | max wait for a response (ms); 30 min — long webchat cogitations exceed 180 s routinely |
| `TOOL_CONTEXT_WINDOW` | `30000` | cap on the tools section of the prompt (chars) |
| `MAX_TOOL_ROUNDS` | `40` | max tool-execution rounds per request |
| `LOGIN_WAIT_SECONDS` | `300` | how long to wait for manual login |
| `API_TOKEN` | *(none)* | bearer token auth |
| `BASH_ALLOWED` | `false` | enable `run_bash` |
| `EXEC_TIMEOUT_MS` | `10000` | per-command bash timeout |
| `COOKIE_FILE` | `.cookies.json` | persisted session cookies |
| `SKIP_BROWSER` | `false` | run server without a browser (testing) |
| `SELECTOR_*` | see `config.js` | comma-separated CSS selector lists, first match wins |
| `CONTEXT_HANDOFF_ENABLED` | `true` | auto-swap to a new chat at the threshold (§7) |
| `CONTEXT_HANDOFF_THRESHOLD` | `2000000` | rough per-request context estimate (chars/4 ≈ tokens) that triggers the handoff |
| `HANDOFF_FILE` | `…/handoff_to_new_chat.md` | where the handoff document is written |

Upstream proxy routes (dual-model mode) read `UPSTREAM_ANTHROPIC_BASE_URL`,
`UPSTREAM_ANTHROPIC_AUTH_TOKEN`, `UPSTREAM_OPENAI_BASE_URL` from `.env` —
streaming passes through untouched (`Readable.fromWeb`).

---

## 10. Troubleshooting

| Symptom | Recipe |
|---|---|
| Gateway alive but **silent** (>120 s, no response, `/status` hangs) | kill the listener PID (by PID, from `ss -tlnp`) — the supervisor respawns it fresh |
| **Gemini errors / echo / garbage** | you are on the 9223 GUI instance — it cannot generate (see §4). Move to 9224. Do not re-debug. |
| Text stuck in the composer, **model menu opened** | the generic `div[role="button"]` fallback hit the model-picker chip. Non-DeepSeek sites need the trusted composer click (§4); if the fallback is the only hit, fix the selectors |
| **403 Forbidden on the CDP websocket** | Chrome 151 rejects handshakes bearing *any* `Origin` header. Connect with the origin suppressed (python `websocket-client`: `suppress_origin=True`) |
| `js-flags` only visible in `/proc` cmdline | your grep alternation is at fault — dump the whole cmdline (`tr '\0' ' '`) |
| `pgrep -f` matches the grep itself | bracket-trick: `pgrep -f 'stack_[s]upervisor[.]sh'` |
| **Supervisor ignores script edits** | a running bash supervisor reads the script incrementally and can miss mid-loop edits. Deterministic fix: kill the supervisor session (NEVER `pkill -f`), respawn it fresh so it reads the new text; children survive the supervisor death |
| Context handoff misfires / too chatty | raise `CONTEXT_HANDOFF_THRESHOLD`, or `CONTEXT_HANDOFF_ENABLED=false`; verify the tee capture is re-armed (versioned file `V=2`) — a stale capture underestimates |
| DOM rows never appear | expected on headless — the stream tee (§6) is the source of truth; DOM is fallback |
| UI changed / selectors stale | set `SELECTOR_INPUT` / `SELECTOR_SEND` / `SELECTOR_MESSAGE` |
| CAPTCHA appears | solve it in the browser window; the poll keeps waiting |
| Rate limited | rotate `WEBCHAT_URL` between chats, or run several instances |

---

## 11. Rules that keep this stack alive

1. **Never push to `main`/`master`** — feature branches only.
2. **One base URL per session** — don't set per-family base URLs in the
   client; route families through `WEBCHAT_ROUTES` instead.
3. **Bind to localhost** (`HOST=127.0.0.1`); if you expose the port, set
   `API_TOKEN`.
4. **Never run two browsers against the same profile** — 9223 and 9224 use
   separate profiles; sharing one corrupts the login.
5. **`run_bash` is a footgun** — the model's output executes verbatim;
   `BASH_ALLOWED=true` only for trusted conversations, `EXEC_TIMEOUT_MS`
   bounds every command.
6. **Automating webchats violates their ToS** — accounts can be
   rate-limited or banned, and providers change their DOM without notice
   (that's what the selector env vars are for). Use at your own risk.
