# Harness audit — 2026-09-23 (agent 9 of 10)

Repo: `/home/roni/Roni_workspace/webchat_worker/harness` · branch `main` @ `2deab51`, clean, pushed.
Scope: the webchat-to-API gateway (server.js/browser.js/tools.js), the `webchat` CLI/TUI (cli/*, bin/*), and config resolution (config.js/master_config.js).
Live evidence: gateway running on `127.0.0.1:8081`; `/health` answered
`{"ok":false,"browserAlive":false,"wedged":false,"outstandingMs":0,"wedgeThresholdMs":2700000}` (HTTP 503).

---

## LENS 1 — ERROR & WAIT FEEDBACK

### Verified current state

- The gateway's HTTP surface returns **flat error strings**, not the 3-part contract
  (`{kind,title,message,hint,actions,canRetry,technical}`) that helpotron ships.
  Example: `server.js:2035` → `error: "Webchat not connected: ${e.message} — run with
  HEADLESS=false, log in, then POST /connect"`. There is a showcase and a CTA, but no
  kind/actions field, and the CTA never varies by cause. The 500 path is equally flat
  (`server.js:2165`), and the SSE error event is a bare message (`server.js:2396`).

- **Waiting/empty detection — the highest-value item.**
  - `/v1/chat/completions` (OpenAI shape) calls `handleRequest` with **no `onProgress`**
    (`server.js:2072-2074`). Its `stream:true` branch then waits for the FULL `text` and only
    after that emits 512-char chunks (`server.js:2112-2118`) — so even a streaming OpenAI
    client sees nothing until the answer is complete.
  - `/v1/messages` non-stream path likewise passes **no `onProgress`**
    (`server.js:2258-2259`) — a bare hang with zero feedback for the whole send.
  - `/v1/messages` stream path is the only surface with any feedback. It emits
    `message_start` (`server.js:2298`), then `: keepalive` SSE **comment** lines every 15s
    (`server.js:2294-2296`), and `onProgress` fires **only** on tool-execution, narration, or
    rejection events (`server.js:2316-2347`). During a minutes-long single-generation
    (Gemini thinking + writing a long answer, no tool calls) **nothing** fires — the caller
    watches a row mounted EMPTY with only invisible keepalive comments.
  - The measured case is real and understood: on a phantom-stop lane (`gemini` quirk
    `phantomStopButton:true`), `busy` reads false for the whole thinking window; the fix is
    the `emptyMountedRowMeansBusy` quirk scoped to a row that `grew` against the pre-send
    snapshot (`browser.js:2393`, comment `browser.js:2370-2392`). The empty-grace for gemini
    is **600,000ms = 10 minutes** (`browser.js:2428`; live config `limits.emptyGraceMs` and
    `webchatModes.gemini.emptyGraceMs` both `600000`). So a Gemini send that mounts an empty
    row can sit for up to 10 minutes with **no determinate progress indicator**.

- **Error paths for throttle/stop/empty — largely good.**
  - Rate limit → `429` + `Retry-After` + a clear sentence, from three distinct surfaces:
    pre-send cooldown (`server.js:2016-2026`), reply-text detection (`server.js:2079-2094`),
    and thrown stream-error detection (`server.js:2143-2160`), all keyed on the vocabulary in
    `rate_limit.js:37-45` and the page-tail throttle notice (`browser.js:2295-2301`).
  - "Stopped generating" → a real sentence: `browser.js:2395-2396` throws
    `Webchat response was stopped (Stop button pressed while generating)`.
  - Empty-after-grace → a real sentence that quotes the page text for diagnosis
    (`browser.js:2442-2443`, `2446-2466`).
  - **CAPTCHA / human-verification: NO detection anywhere.** `grep -i captcha|challenge|robot|verify`
    across server.js/browser.js/tools.js returns nothing. A CAPTCHA page is indistinguishable
    from a slow answer until the 600s grace expires, then surfaces as a generic
    "response is empty after 600s — stopped or aborted by the UI".

### The gap (ranked by impact)

1. **G1 — no determinate progress during a long wait (highest).** The 270s empty mount is the
   caller's real experience, and there is no indicator beyond the stream-path keepalive. The
   OpenAI path and the non-stream Anthropic path have no keepalive at all.
2. **G2 — CAPTCHA/challenge is invisible.** A live verification wall looks exactly like a hung
   send for 10 minutes.
3. **G3 — error surface is unstructured.** A CLI/agent cannot choose a CTA by error kind because
   the gateway emits flat strings, so the 3-part contract is not realized on the HTTP side.

### Plan (surgical)

1. **G1 — heartbeat on every path.** In `server.js`, hoist the keepalive `setInterval` out of the
   stream-only branch so the non-stream `/v1/messages` (`server.js:2258`) and
   `/v1/chat/completions` (`server.js:2072`) also send `: keepalive\n\n` — but these are
   non-SSE responses, so instead emit **headers** (`res.setHeader`) is not enough; the correct
   minimal change is to give the non-stream paths an SSE-optional keepalive by writing
   `: keepalive` only when the response is `text/event-stream`. For JSON responses, set a
   **long `timeout`/`keepAliveTimeout`** on the server so the client socket is not dropped
   mid-cogitation, and document that JSON callers must set their own read timeout.
   - Exact change: extract `const heartbeat = setInterval(...)` to a helper `startKeepalive(res)`
     and call it in all three branches; guard with `if (res.getHeader('content-type')?.includes('text/event-stream'))`.
   - Test: `harness_tests/features.test.js` — assert a slow fake send still receives a keepalive
     byte within 16s on the non-stream path.
   - Verify: `node --test harness_tests/*.test.js`.

2. **G1 — a determinate "still working" progress line.** In `server.js:2316` `onProgress`, emit a
   first-class `content_block_delta` of `⏳ thinking… (no tokens yet)` the moment
   `handleRequest` enters the wait loop, and a periodic `⏳ still generating (Ns)` line every 60s
   while no content has arrived (track `sawContent`). This turns an indefinite wait into a visible,
   time-stamped one.
   - Exact change: in `handleRequestInner`, before the first `sendPrompt`, call
     `onProgress?.({type:'text', text:'⏳ sent to the webchat — waiting for the first token'})`;
     add a `setInterval`-free counter in the poll loop that re-emits every 60s until `sawContent`.
   - Test: unit-test the progress emission count against a stub `sendPrompt` that resolves late.
   - Verify: `node --test harness_tests/*.test.js`.

3. **G2 — CAPTCHA detection.** In `browser.js` `waitForResponse`, extend the page-tail notice
   check (`browser.js:2295-2301`) with a second `page.evaluate` that tests for challenge markers
   (`iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, `/verify you are human|not a robot/i`
   on `body.innerText`). Throw `Webchat challenge: <text>` so `server.js` surfaces it as a 4xx
   with `type:'challenge'` instead of an empty-after-grace timeout.
   - Exact change: add a `challengeNotice()` next to the throttle check; rethrow its own words.
   - Test: `harness_tests/features.test.js` — a fake page with a recaptcha iframe throws the
     challenge error, not the empty error.
   - Verify: `node --test harness_tests/*.test.js`.

4. **G3 — structured error envelope.** Replace the flat `error:` strings at
   `server.js:2035,2165,2223,2393,2396` with a `{type, kind, message, hint, retryable}` object.
   Add a tiny `kindFor(err)` mirroring helpotron's `web/src/lib/errors.js` vocabulary
   (`connect` → `sign-in`, `rate_limit` → `retry`, `challenge` → `sign-in`, `empty` → `retry`).
   - Exact change: a new `harness/errors.js` with `kindFor`/`actionsFor`, imported by server.js;
     every error path returns `res.status(code).json({ error: {...} })` with `kind` and `retryable`.
   - Test: `harness_tests/features.test.js` asserts the JSON shape and `kind` for each path.
   - Verify: `node --test harness_tests/*.test.js`.

---

## LENS 2 — SECURITY & LEAKAGE

### Verified current state

- **Bind host is 127.0.0.1 by default.** `config.js:42`
  `host: MC.pickStr('HOST','server','host') || '127.0.0.1'`; live config `server.host: "127.0.0.1"`
  and `.env` `HOST=127.0.0.1` both confirm. `server.js:2510` `app.listen(config.port, config.host)`.
- **Authentication is opt-in and currently OFF.** `config.js:139` `apiToken: process.env.API_TOKEN || null`;
  the middleware is only installed `if (config.apiToken)` (`server.js:668-675`). The live `.env`
  has **no `API_TOKEN`**, so `config.apiToken === null` → no auth. Because the bind is localhost-only,
  exposure is currently limited to local processes.
- **No enforcement of the "beyond localhost ⇒ token" rule.** `server.host` is user-editable in the
  CLI (`cli/settings.js:68`, help text "Keep this on 127.0.0.1 unless you also set an API token"),
  but `server.js` never checks `host !== '127.0.0.1'` against `apiToken`. A user who sets
  `server.host: 0.0.0.0` (or `HOST=0.0.0.0`) exposes the logged-in browser with zero auth and zero
  boot warning (the only "warning" is a one-line `server.js:2505` when a token *is* set).
- **Chrome profile (live cookies) is git-ignored and never tracked.** `.webchat/` is ignored
  (`.gitignore:75`), verified `git check-ignore -v .webchat/chrome-profile` → exit 0. The live
  profile is actually at `/home/roni/Roni_workspace/webchat_worker/chrome-profile` — the PARENT of
  the clone, entirely outside the repo, so it is not even subject to gitignore. The in-repo
  `.webchat/` is empty (0 files). `git log --all --diff-filter=A --name-only` for
  `.webchat/chrome-profile/*` and `chrome-profile/*` returns nothing.
- **No secrets in the repo or history.** `.env` is git-ignored (`.gitignore:2`, check-ignore exit 0)
  and never committed (`git log --all --oneline -- .env` is empty). The only `sk-…` in history is the
  placeholder `.env.example:37` `# UPSTREAM_ANTHROPIC_AUTH_TOKEN=sk-your-paid-key`. `DEEPSEEK_API_KEY`
  appears in history only as a config NAME reference, never a value.
- **Logging cannot leak a key.** Request bodies are never printed — only char counts
  (`server.js:2053` `clientSystemText.length`, `server.js:1064/1249` `lastReqBodyChars`).
  `DEEPSEEK_API_KEY` is read at `tools.js:334` and used only in the fetch `x-api-key`/`Authorization`
  header (`tools.js:370`), never logged. `config.apiToken` is logged only as a boolean presence
  (`server.js:2505`). `cli/daemon.js` logs no env values. Verified: no `console.log` path can emit a key.

### The gap

- **G4 — nothing stops a non-localhost bind with no token.** The documented, owner-recommended
  threat model ("anyone who can reach the port can use the logged-in accounts") is protected only
  by convention, not code.

### Plan

1. **G4 — enforce at boot.** In `server.js` `main()` (`server.js:2502`), before `app.listen`, add:
   ```js
   if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.apiToken) {
       throw new Error(`server.host=${config.host} exposes a logged-in browser without API_TOKEN — set API_TOKEN or bind 127.0.0.1`);
   }
   ```
   - Test: `harness_tests/features.test.js` — `setRequestInFlight` seam style: assert the throw for
     `{host:'0.0.0.0', apiToken:null}` and no throw for `{host:'0.0.0.0', apiToken:'x'}`.
   - Verify: `node --test harness_tests/*.test.js`.

2. **G4 — surface the token requirement in the CLI Doctor.** In `cli/index.js` `screenDoctor`
   (`cli/index.js:772`), add a warning row when `host !== '127.0.0.1'` and `__env__.API_TOKEN` is
   unset. No test needed beyond the smoke test; verify with `webchat doctor`.

---

## LENS 3 — EMPTY & SUCCESS STATES (TUI)

### Verified current state

- **Config with no tabs found** → `cli/index.js:246-252`: `"Found N tab(s)"` then
  `"No tab matches the selected webchat. Open it there, then retry."` — why + next action. Good.
- **`webchat status` with no gateway** → `cli/index.js:841` `"gateway stopped"`, returns exit 1
  (`cli/index.js:844`). Good.
- **Empty settings screen** → impossible: `SCHEMA` is a hardcoded 5-group list
  (`cli/settings.js:37-301`); every group renders a count. No empty state needed.
- **`saveRaw` atomicity is real** (`cli/settings.js:425-437`): backup via `copyFileSync` →
  `writeFileSync(tmp)` → `renameSync(tmp, file)`. On failure the original is untouched and the
  caller's top-level `try/catch` (`cli/index.js:871-886`) shows "Something went wrong" with the
  message. Success is confirmed: `editSetting` shows "Saved" (`cli/index.js:550`), `screenPickMode`
  shows "Saved"/"Cleared" (`cli/index.js:179`). A shadowed save is honestly reported
  "Saved — but not in effect" (`cli/index.js:541-548`).
- **BUG — the "browser attached" success state is unreachable.** `cli/daemon.js:118`
  computes `attached: Boolean(parsed && parsed.alive)`, but `/health` emits **`browserAlive`**
  (and `ok`), never `alive` (`server.js:1907-1913`:
  `res.status(...).json({ ok, browserAlive: alive, wedged, outstandingMs, wedgeThresholdMs })`).
  Verified live: `/health` returns `{"ok":false,"browserAlive":false,...}` — there is no `alive`
  key. So `gw.attached` is **always `false`**, and the dashboard line
  (`cli/index.js:72-74`) and Doctor line (`cli/index.js:775-779`) can never show
  "up · browser attached" / "browser attached". `gw.wedged` is fine (`parsed.wedged` exists).

### The gap

- **G5 — `attached` reads a nonexistent field.** The TUI's one success indicator (browser actually
  attached) always reports the "waiting" state even when a tab is connected.

### Plan

1. **G5 — fix the field.** In `cli/daemon.js:118`, change
   `attached: Boolean(parsed && parsed.alive)` → `attached: Boolean(parsed && (parsed.browserAlive || parsed.ok))`.
   - Test: `harness_tests/cli_settings.test.js` (or a new daemon test) — feed a
     `{browserAlive:true}` body and assert `probeGateway` returns `attached:true`; feed
     `{browserAlive:false}` and assert `false`.
   - Verify: `node --test harness_tests/*.test.js`.

2. **G5 (hardening) — name the health fields canonically.** In `server.js:1907`, add an `alive`
   alias to the body (`alive: alive && !wedged`) so future consumers cannot hit the same
   mismatch, and note the canonical field in the handler comment.

---

## LENS 4 — RESOURCE SAFETY

### Verified current state

- **CLI launch can produce a VISIBLE window.** `cli/daemon.js:225-234` builds args
  `--remote-debugging-port`, `--user-data-dir=<profile>`, `--no-first-run`,
  `--no-default-browser-check`, `--disable-features=Translate`; `--headless=new` is added
  **only if `opts.headless`** (`daemon.js:233`). `screenLaunch` calls
  `D.launchBrowser({ port, url })` with **no headless** (`cli/index.js:202`) — intentionally headed
  for login.
- **Gateway launch is also headed.** `browser.js:144-149` `puppeteer.launch({ headless: config.headless })`
  with `config.headless` = `HEADLESS` env = `false` → headed. `detached:true` (`browser.js:148`)
  so a crash can be reaped.
- **The "never pop up" rule has NO harness-level enforcement.** Minimization lives entirely in the
  EXTERNAL `show-window.sh` + `minimize-guard.sh` (documented `show-window.sh:1-18`); `launch-agent.sh`
  contains **zero** headless/minimize/DISPLAY references (grep empty). The CLI and gateway both open
  a headed window; only a manually-started guard re-minimizes every ~2s.
- **Orphaned Chrome.**
  - Gateway-launched Chrome: closed on shutdown via `closeBrowser()` with a 5s race
    (`server.js:2521-2531`). Good.
  - CLI-launched Chrome (`daemon.js:237-243`, `detached:true` + `unref`): survives CLI exit by design
    (login persists); the pidfile is the only handle. `stopProcess('browser')` exists
    (`daemon.js:154`) but is **never called** — there is no "stop browser" action in the TUI, so a
    CLI-launched browser can only be killed by hand.
- **Latent `pkill` use.** `server.js:1762` runs `spawnSync('pkill', ['-f', 'stack_supervisor[.]sh'])`
  — it uses the bracket-safe form, but it still violates the standing "pkill is DENIED" rule.

### The gap

- **G6 — nothing re-minimizes a headed browser from inside the harness.** The one documented
  incident (runaway Chrome re-raising on focus, owner closing it by hand) is mitigated only by an
  opt-in external script.
- **G7 — CLI-launched browsers are unmanaged** (no stop path, pidfile only).

### Plan

1. **G6 — auto-minimize on gateway launch.** In `browser.js` `initBrowser`, after a headed
   `puppeteer.launch`, shell out to the existing `show-window.sh drop` (guarded by
   `fs.existsSync` and `DISPLAY`), or launch with an `--window-position=-32000,-32000` /
   `--window-size=1,1` arg so the window opens off-screen when `config.headless` is false but the
   owner is not logging in. Prefer the `show-window.sh drop` call — it is already the owner's
   tested mechanism.
   - Exact change: in `browser.js:150`, after `attachDisconnectGuard()`, add a best-effort
     `if (!config.headless && process.env.DISPLAY) spawn('bash',[path.join(__dirname,'show-window.sh'),'drop'],{detached:true,stdio:'ignore'}).unref()`.
   - Test: assert the spawn is skipped when `config.headless` is true (unit test with a seam).
   - Verify: `node --test harness_tests/*.test.js`.

2. **G7 — add a "Stop browser" action.** In `cli/index.js` `screenSite` menu, add a
   `{label:'Stop the browser', value:'stop'}` entry that calls `D.stopProcess('browser')` and
   reports the pid. Confirm before killing (`A.confirm`) since it destroys the login session
   handle.
   - Test: `harness_tests/cli_settings.test.js` — stub `stopProcess` to return
     `{stopped:true,pid:1}` and assert the menu dispatch calls it.
   - Verify: `node --test harness_tests/*.test.js`.

---

## LENS 5 — CONFIG CORRECTNESS

### Verified current state

- **Two config files confirmed, and they differ.** In-clone template
  `harness/harness.config.json` (tracked; `server.port: 8080`, `limits.timeoutMs: 1800000`) vs
  LIVE `/home/roni/Roni_workspace/webchat_worker/harness.config.json` (`modelName: gemini-webchat`,
  `limits.timeoutMs: 900000` at live line 177, gemini quirks + `emptyGraceMs: 600000`, scoped
  sandbox roots). `harness/.env:13` `HARNESS_CONFIG=/home/roni/Roni_workspace/webchat_worker/harness.config.json`
  points at the live file. The wedge threshold confirms it: live `/health` returned
  `wedgeThresholdMs:2700000` = `900000 × 3`, matching the LIVE timeout, not the template's.
- **Resolution order matches across both loaders.** `master_config.js:18` reads
  `process.env.HARNESS_CONFIG` (after `config.js:1` `require('dotenv').config()`); precedence in
  `pick/pickBool/pickNum/pickStr/pickList` is env > file > undefined→caller default
  (`master_config.js:42-91`). The CLI mirrors it: `cli/settings.js:403-409` `configFilePath` =
  explicit > `process.env.HARNESS_CONFIG` > `dotenv.vars.HARNESS_CONFIG` > in-clone template, and
  `resolve()` (`cli/settings.js:466-510`) is env > file > `'default'`. **Consistent.**
- **`shadowedBy` reporting is not misleading.** `cli/settings.js:495-506` sets `shadowedBy`,
  `shadowedWhere`, `shadowedFileValue` when env wins, and the CLI renders them
  (`cli/index.js:120,416,542-548`). The `.env` carries exactly 11 setting-mapped vars
  (HOST, PORT, HEADLESS, WEBCHAT_MODE, MODEL_NAME, WEBCHAT_URL, TAB_URL_SUBSTRING, CDP_WS_URL,
  TAB_ID, NARRATION, ALLOW_PLAIN_TEXT) — matching the "11 env-shadowed" measurement.
- **Dead gitignore rule.** `.gitignore:66` `/harness.config.json` intends to ignore the in-clone
  template, but that file is already **tracked** (`git ls-files` lists it; `git check-ignore -v
  harness.config.json` → exit 1 = not ignored). The rule is inert today; it would only bite if the
  template were ever `git rm`'d, after which a user's edits would silently vanish.

### The gap

- **G8 — the template is a trap for hand-editors.** Code resolution is correct (the CLI writes the
  LIVE file), but the template's own `_README` (`harness.config.json:2-34`) documents precedence
  without saying "if `HARNESS_CONFIG` is set, THIS file is not the live config." A user who edits
  the in-clone template sees nothing change — the exact failure mode the audit was asked to check.

### Plan

1. **G8 — make the trap visible.** In the template `harness.config.json` `_README`, add a first
   entry: `"If HARNESS_CONFIG is set (harness/.env), this file is the TEMPLATE — the live config is
   the file HARNESS_CONFIG names. Edit that, or use the webchat CLI."`. No code change.
   - Verify: `grep -n HARNESS_CONFIG harness.config.json` shows the warning.

2. **G8 (defensive) — warn at boot on divergence.** In `server.js` `main()`, if
   `process.env.HARNESS_CONFIG` is set AND `require('./master_config').CONFIG_FILE !== path.resolve(__dirname,'harness.config.json')`,
   `console.warn` one line naming the live file. This makes the indirection visible in the gateway
   log without touching behaviour.
   - Verify: restart-safe check via `node --check server.js`; observe the warning line at boot.

---

## ALREADY GOOD — do not churn

- **Capability filter** (`tools.js:329-332` `available()` + `server.js` `buildExecutableToolDefs`):
  unmet-requirement tools are withheld; the keyless `search_web` returns one clear message instead
  of a loop (`tools.js:335-353`). The user's original complaint is closed.
- **Phantom-stop busy signal** extracted to module scope `busyProbe` (`browser.js:1613`), and the
  phantom-stop/`aria-busy` split (`browser.js:1630-1674`) is genuinely correct.
- **`saveRaw` atomic write + backup** (`cli/settings.js:425-437`) is real and the failure mode
  (truncated config silently reverting every setting) is correctly guarded.
- **Rate-limit detection on three surfaces** (`server.js:2016,2079,2143` + `rate_limit.js`) with
  per-account cooldown — the throttle is surfaced as a clear 429 sentence, never a bare timeout.
- **No-secret logging discipline**: only char counts and boolean presences are logged; keys are
  used solely in request headers. Verified across server.js/tools.js/cli.
- **Git hygiene**: `.env` and `.webchat/` ignored and never tracked; no credential in history;
  the live profile lives OUTSIDE the repo.
- **The 503-means-up `/health` design** is deliberate and the CLI reads the BODY
  (`cli/daemon.js:108-121`), not the status — correct, aside from the `attached` field bug (G5).
- **ESC-ambiguity handling** in `cli/ansi.js:206-276` (lone ESC held 60ms) and the pure
  formatting/testable split are solid.

---

## RISKS / DO NOT DO

- **Do NOT add a determinate progress meter by polling the tab from the gateway.** Any extra
  `page.evaluate` per second on a thinking model's tab is exactly the cost the empty-grace work was
  trying to avoid; the progress signal must come from the existing poll loop, not a new one.
- **Do NOT default the browser to headless** to "fix" the pop-up. `browser.js:144` is headed on
  purpose — headless gets signed out and is a fingerprint tell (`show-window.sh:5-7`). Minimize
  instead (G6).
- **Do NOT bind `0.0.0.0` to test anything**, and do not add a blanket auth that breaks the local
  agents already pointed at `:8081`. The token must stay opt-in; only the *non-localhost* case is
  enforced (G4).
- **Do NOT "fix" the `pkill` at `server.js:1762` by hand in this pass** — it is bracket-safe today,
  but any change must use `pgrep`+`kill <pid>` per the standing rule. Flag-only.
- **Do NOT touch `~/.claude/**`, the dirty helpotron tree, or restart `helpotron-api.service`.**
- **Do NOT revert/`git checkout` anything**; the tree is clean and pushed — this report is the only
  new file. Do not commit it without the owner's go-ahead.
- **`.gitignore` should NOT exclude `plans/`.** The report is a deliverable meant to be tracked;
  the existing `*.bak-*` (`gitignore:28`) already covers stray backups, and the live-config
  `.bak-*` files live OUTSIDE the repo anyway. Leave `plans/` tracked.

## UNVERIFIED

- Live Chrome/CDP state (port 9225) was not inspected this session beyond the gateway's own
  `/health` self-report (`browserAlive:false` at probe time); the browser may have attached since.
- The exact 270s Gemini empty-mount is taken from the code comments (`browser.js:2372-2378`) and
  the live config's `600000` grace, not re-measured this session.
