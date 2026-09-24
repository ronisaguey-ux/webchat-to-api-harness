require('dotenv').config();

// Master config (harness.config.json): env var > this file > the default below.
// Turn features on/off and set their values in that one file.
const MC = require('./master_config');

// ── Webchat mode ───────────────────────────────────────────────────────────
// Different webchats need different selectors and submit behaviour. A mode
// supplies them; anything set explicitly (env or the top-level keys) still wins.
const MODES = (MC.raw.webchatModes && typeof MC.raw.webchatModes === 'object') ? MC.raw.webchatModes : {};
const MODE_NAME = MC.pickStr('WEBCHAT_MODE', 'webchat', 'mode') || 'generic';
const MODE = (MODES[MODE_NAME] && typeof MODES[MODE_NAME] === 'object') ? MODES[MODE_NAME] : {};
if (!MODES[MODE_NAME]) {
    console.warn(`⚠️ unknown webchat.mode "${MODE_NAME}" — falling back to generic. ` +
        `Known modes: ${Object.keys(MODES).join(', ') || '(none configured)'}`);
}
const modeSel = (MODE.selectors && typeof MODE.selectors === 'object') ? MODE.selectors : {};
const modeQuirks = (MODE.quirks && typeof MODE.quirks === 'object') ? MODE.quirks : {};

// ── System prompt ──────────────────────────────────────────────────────────
// perMode[mode] > text > the harness's built-in prompt ('' = built-in).
const SP = (MC.raw.systemPrompt && typeof MC.raw.systemPrompt === 'object') ? MC.raw.systemPrompt : {};
const SP_PER = (SP.perMode && typeof SP.perMode === 'object') ? SP.perMode : {};
const SYSTEM_PROMPT = String(
    (process.env.SYSTEM_PROMPT)
    || (SP_PER[MODE_NAME] && String(SP_PER[MODE_NAME]).trim())
    || (SP.text && String(SP.text).trim())
    || ''
);
const env = (n) => process.env[n];  // kept for readability at the call sites

// chat.js overrides (paste your tab URL there — it wins over .env)
let chat = {};
try {
    chat = require('./chat.js');
} catch {
    /* chat.js missing — fall back to .env */
}

const cfg = {
    // Server
    host: MC.pickStr('HOST', 'server', 'host') || '127.0.0.1',
    port: MC.pickNum('PORT', 'server', 'port') || 8080,

    // Webchat target — WEBCHAT_URL_OVERRIDE=true lets a second instance
    // (different PORT) pin its own thread even though chat.js exists
    // (chat.js normally wins). Multi-instance pattern 08-12.
    webchatMode: MODE_NAME,
    // Precedence for the target URL: an explicit env/URL override, then the
    // selected MODE's url, then chat.js, then the built-in default. The mode
    // has to outrank chat.js: chat.js is a hardcoded per-machine tab URL, so
    // without this every mode would silently drive this box's DeepSeek tab
    // (verified: WEBCHAT_MODE=notegpt still resolved to chat.deepseek.com/...).
    webchatUrl: MC.pickStr('WEBCHAT_URL', 'webchat', 'url')
        || MODE.url
        || chat.url
        || 'https://chat.deepseek.com',
    // Second-instance tab matching: when set, pick the tab whose URL CONTAINS
    // this substring instead of first-tab-with-matching-origin — lets two
    // instances share one browser, each pinned to its own thread.
    tabUrlSubstring: MC.pickStr('TAB_URL_SUBSTRING', 'webchat', 'tabUrlSubstring') || MODE.tabUrlSubstring || null,
    // 09-16: TAB_ID pins the gateway to ONE CDP target. TAB_URL_SUBSTRING is not
    // enough when two tabs carry the SAME url - Gemini resets every new chat to
    // /app, so two gateways both matched both tabs, `pages.find` returned the
    // first for each, and they typed into one composer: the prompt stayed put,
    // the in-page click never committed, and each send burned the full deadline.
    tabId: MC.pickStr('TAB_ID', 'webchat', 'tabId') || MODE.tabId || null,
    // Conversation mode (08-12): accept plain-text replies as the final answer
    // instead of demanding fenced tool JSON — for personal threads whose model
    // talks like a friend. Tool calls still work when the model makes them.
    allowPlainText: MC.pickBool('ALLOW_PLAIN_TEXT', 'features', 'allowPlainText') === true,
    // 09-22 A2: research-only / no-tools mode. When true the model is offered NO
    // work tools — only submit_answer — so it answers research / plain-English
    // implementation tasks in prose without touching files. This is the user's
    // stated fallback ("DeepSeek provides research and plain-English
    // implementation tasks for another agent").
    noTools: MC.pickBool('NO_TOOLS', 'features', 'noTools') === true,
    // 09-12 (owner): the "send a 💬 line before every work tool call" rule is a
    // legacy harness feature for when the owner drives a chat himself. Off by
    // default for autonomous runs; set NARRATION=true to get it back.
    narration: MC.pickBool('NARRATION', 'features', 'narration') === true,
    // The caller supplies its own strict output contract in the system text and
    // this gateway must not append a competing one. Set by the oculus step
    // engine lane, whose contract is {"edits":[...]} — see server.js handleRequest.
    passthroughFormat: MC.pickBool('PASSTHROUGH_FORMAT', 'features', 'passthroughFormat') === true,
    headless: MC.pickBool('HEADLESS', 'server', 'headless') === true,
    modelName: MC.pickStr('MODEL_NAME', 'server', 'modelName') || 'deepseek webchat',
    // 08-13 MULTI-SITE: env FIRST — chat.js carries a hardcoded 9224 URL, so
    // CDP_WS_URL was ignored and no instance could target the 9223 GUI
    // browser (qwen/kimi/gemini logged-in tabs).
    cdpWsUrl: MC.pickStr('CDP_WS_URL', 'webchat', 'cdpWsUrl') || chat.cdpWsUrl || null,
    // 08-13 VIEWPORT PIN: on WM-less X sessions Chrome renderers can freeze
    // at the launch-time size (all 9223 GUI tabs were stuck 800x600 inside
    // 1920x1034 windows — resize events never arrive, page rendered
    // quarter-size with the window surface around it). When set, the gateway
    // pins the layout viewport via Emulation.setDeviceMetricsOverride right
    // after attaching to the tab. Headless instances leave it unset.
    viewportW: MC.pickNum('VIEWPORT_W', 'webchat', 'viewportW') || 0,
    viewportH: MC.pickNum('VIEWPORT_H', 'webchat', 'viewportH') || 0,
    // 08-14 OPTIMIZATION (owner's performance guide): network-level asset
    // blocking — images/fonts/media are aborted at the CDP layer (RAM +
    // bandwidth win on heavy sites like gemini; document/script/xhr/fetch/
    // websocket always pass). Stylesheets blocked only when BLOCKED_CSS=1
    // (deepseek SPAs are stable; gemini's layout is fragile — leave off).
    // BLOCKED_URLS_EXTRA = comma-separated extra glob patterns.
    blockedUrls: (MC.pickList('BLOCKED_URLS_EXTRA', 'network', 'blockedUrlsExtra') || [])
        .concat(MC.pickBool('BLOCKED_CSS', 'features', 'blockedCss') === true ? ['*.css*'] : [])
        .concat(['*.png*', '*.jpg*', '*.jpeg*', '*.gif*', '*.webp*', '*.avif*',
                 '*.svg*', '*.ico*', '*.woff*', '*.woff2*', '*.ttf*', '*.otf*',
                 '*.mp4*', '*.mp3*', '*.webm*']),

    // Context handoff (08-13, threshold corrected 08-14): when the completion
    // REQUEST body (history + system + tools + message) crosses the threshold,
    // the gateway stops the tool loop, has the model write a handoff document,
    // opens a NEW chat in the same tab, and seeds it with the document as the
    // first message. Measured in REQUEST-BODY CHARS from the in-page tee;
    // rough mapping chars/4 ≈ tokens (English-heavy; CJK is denser — env
    // override CONTEXT_HANDOFF_THRESHOLD for exactness). The webchat model's
    // window is ~1M tokens (user 08-14), so the default hands off at 500k
    // tokens ≈ 2,000,000 chars — half the window, ample room for the doc-write
    // rounds + final summary before the real cap. The hard-cancel safety net
    // (context_length_exceeded → handoff) still catches any early cap.
    contextHandoffEnabled: MC.pickBool('CONTEXT_HANDOFF_ENABLED', 'features', 'contextHandoff') !== false,
    contextHandoffThreshold: MC.pickNum('CONTEXT_HANDOFF_THRESHOLD', 'limits', 'contextHandoffThreshold') || 2000000,
    handoffFile: require('./paths').handoffFile(),

    // Behaviour
    timeout: MC.pickNum('TIMEOUT', 'limits', 'timeoutMs') || 1800000, // 08-13 EVENING: run-until-done tasks + 6s send spacing + narration exceed 180s routinely; the 180s cap timed out mid-task and its crash path killed the process (now guarded). 08-14: 10 min still too short — the webchat cogitated SILENTLY 11 min on 'add EVERYTHING' (08-13 22:5x) and BOTH the gateway timeout and the client stream-idle watchdog fired. 30 min default; the SSE keepalive (server.js) keeps clients alive through it.
    toolContextWindow: MC.pickNum('TOOL_CONTEXT_WINDOW', 'limits', 'toolContextWindow') || 30000, // Claude Code's tool list + schemas is ~20K chars
    loginWaitMs: (MC.pickNum('LOGIN_WAIT_SECONDS', 'webchat', 'loginWaitSeconds') || 300) * 1000,
    maxToolRounds: MC.pickNum('MAX_TOOL_ROUNDS', 'limits', 'maxToolRounds') || 40,
    // ★ How much of a tool result the MODEL is shown, in the follow-up prompt. Must stay
    // under the webchat composer's own limit, because a prompt that exceeds it is
    // SILENTLY TRUNCATED by the site — measured on Gemini: 150,682 chars sent, 30,717
    // kept, and the model then worked from a prompt with the middle missing.
    // The cap is what keeps a big read_file from exceeding that: the result is shown
    // head+tail with an explicit "N characters dropped" marker, so the model knows it is
    // seeing part of the file and can ask for a window instead of assuming it saw it all.
    modelToolResultCap: MC.pickNum('MODEL_TOOL_RESULT_CAP', 'limits', 'modelToolResultCap') || 16000,
    // 09-13: how many rounds BEFORE maxToolRounds the harness stops the model and
    // demands its final answer, so running out of rounds yields a summary instead
    // of an error. Configurable in harness.config.json (limits.wrapUpRounds).
    wrapUpRounds: MC.pickNum('WRAP_UP_ROUNDS', 'limits', 'wrapUpRounds') || 3,
    skipBrowser: MC.pickBool('SKIP_BROWSER', 'features', 'skipBrowser') === true,

    // Security
    apiToken: process.env.API_TOKEN || null,
    bashAllowed: MC.pickBool('BASH_ALLOWED', 'features', 'bashAllowed') === true,
    execTimeoutMs: MC.pickNum('EXEC_TIMEOUT_MS', 'limits', 'execTimeoutMs') || 10000,
    execMaxBuffer: 4 * 1024 * 1024,

    // Sandbox (see sandbox.js). Every file path and every path-like token in a
    // bash command must resolve inside one of these roots. Defaults to the
    // oculus-relevant paths; override with a comma-separated SANDBOX_ROOTS.
    sandbox: {
        enabled: MC.pickBool('SANDBOX_ENABLED', 'features', 'sandbox') !== false,
        roots: MC.pickList('SANDBOX_ROOTS', 'network', 'sandboxRoots') || [],
        allowBash: MC.pickBool('SANDBOX_ALLOW_BASH', 'features', 'sandboxAllowBash') === true,
        log: process.env.SANDBOX_LOG !== 'false',
    },

    // 09-13: webchat-specific behaviour from the selected mode (see
    // harness.config.json → webchatModes). Empty object for "generic".
    quirks: modeQuirks,
    // The system prompt the caller wants sent; '' means "use the built-in".
    systemPrompt: SYSTEM_PROMPT,
    // When true the caller's own system message is dropped entirely and only the
    // harness prompt is sent. For agent callers (opencode, Claude Code) whose
    // system prompt is their own harness's rulebook and has no meaning in a
    // webchat tab.
    ignoreClientSystem: MC.pickBool('IGNORE_CLIENT_SYSTEM', 'features', 'ignoreClientSystem') === true,

    // 09-13 EXPERIMENTAL — reasoning-loop detection. Off by default; see the
    // README "Anti-spiral" section. NARRATION=true also relaxes the detector so
    // narration is never mistaken for a loop.
    antiSpiral: MC.pickBool('ANTI_SPIRAL', 'features', 'antiSpiral') === true,

    // 09-13: a webchat that answers "Messages too frequent" is throttling us.
    // Cool that account and answer 429 + Retry-After instead of retrying into
    // the throttle. See rate_limit.js.
    rateLimitCooldownSeconds: MC.pickNum('RATE_LIMIT_COOLDOWN_S', 'features', 'rateLimitCooldownSeconds') || 900,

    // ── 09-22 (owner): native web search + deepthink toggles per webchat ────
    // DeepSeek and Gemini have NATIVE search in their own UI, so the harness
    // must not fake a search for them — it flips the lane's own controls ON
    // before a send. deepThink/search come from the mode's `native` block
    // (webchatModes.<mode>.native) and fall back to webchat.native; the search
    // capability is CONFIGURABLE ON/OFF per mode. See browser.js ensureToggles.
    native: (MODE.native && typeof MODE.native === 'object') ? MODE.native
        : ((MC.raw.webchat && MC.raw.webchat.native && typeof MC.raw.webchat.native === 'object')
            ? MC.raw.webchat.native : {}),
    // DeepThink defaults ON (the harness has always forced it); native search
    // defaults OFF (turning it on changes what the lane does, so it is opt-in).
    nativeDeepThink: ((MODE.native || {}).deepThink !== undefined)
        ? MODE.native.deepThink === true
        : ((((MC.raw.webchat || {}).native || {}).deepThink !== undefined)
            ? MC.raw.webchat.native.deepThink === true
            : true),
    nativeSearch: ((MODE.native || {}).search !== undefined)
        ? MODE.native.search === true
        : ((((MC.raw.webchat || {}).native || {}).search !== undefined)
            ? MC.raw.webchat.native.search === true
            : false),
    // search_web availability: the paid key, OR a lane whose native search is on.
    // search_web is never advertised when neither holds (A1: never offer a tool
    // whose requirement is unmet).
    webSearchAvailable: !!process.env.DEEPSEEK_API_KEY
        || ((MODE.native || {}).search === true)
        || (((MC.raw.webchat || {}).native || {}).search === true),

    // ── 09-22 (owner): pick the model INSIDE the webchat from the CLI ───────
    // Records the model; browser.js sets it in the tab's own picker before a
    // send (the control is per-mode — gemini's is button[aria-label^="Open mode
    // picker"], discovered live 09-22).
    webchatModel: MC.pickStr('WEBCHAT_MODEL', 'webchat', 'model') || MODE.model || '',

    // ── 09-22 (owner): tool-result compaction as a config option ────────────
    // Ports the owner's tool-call-compactor rules (never touch errors, head+tail
    // truncation). See compactor.js. Off by default.
    // 09-23: default ON. Two independent costs made OFF the wrong default:
    //   1. A single run_bash can return 4 MB (execMaxBuffer), and every byte is
    //      re-sent on EVERY later round of that turn. The report "broad command
    //      output can be large, contributing to repeated follow-up turns" is this.
    //   2. Compaction is not an optimisation for a chat lane — it is what keeps the
    //      tab out of the context-handoff path, which is where runs get expensive.
    // Set TOOL_COMPACTOR=false (or features.toolCompactor:false) to turn it off.
    toolCompactor: MC.pickBool('TOOL_COMPACTOR', 'features', 'toolCompactor') !== false,
    compactor: {
        maxText: MC.pickNum('COMPACTOR_MAX_TEXT', 'compactor', 'maxText') || 10000,
        maxItems: MC.pickNum('COMPACTOR_MAX_ITEMS', 'compactor', 'maxItems') || 10,
        headItems: MC.pickNum('COMPACTOR_HEAD_ITEMS', 'compactor', 'headItems') || 3,
        tailItems: MC.pickNum('COMPACTOR_TAIL_ITEMS', 'compactor', 'tailItems') || 2,
    },

    // ── 09-22 (owner): a memory file the user OR the agent can edit ─────────
    // Included in the system prompt (so it is in effect) and editable through the
    // read_memory / edit_memory tools. Bounded — it rides into every request.
    memoryEnabled: MC.pickBool('MEMORY_ENABLED', 'features', 'memory') === true,
    memoryMaxChars: MC.pickNum('MAX_MEMORY_CHARS', 'memory', 'maxChars') || 20000,

    // ── 09-22 (owner): attach ANY MCP server ────────────────────────────────
    // Raw section, read directly: mcp.servers = [{ name, command, args, url }].
    // Discovered lazily (see mcp.js) and merged into the executable tool set.
    mcpServers: (MC.raw.mcp && Array.isArray(MC.raw.mcp.servers)) ? MC.raw.mcp.servers : [],

    // ── 09-22 (owner): more control over the tool-call loops ────────────────
    // malformed-tool-JSON correction rounds (was hardcoded at 3).
    maxMalformedRounds: MC.pickNum('MAX_MALFORMED_ROUNDS', 'limits', 'maxMalformedRounds') || 3,

    // Session persistence
    cookieFile: MC.pickStr('COOKIE_FILE', 'paths', 'cookieFile') || '.cookies.json',

    // Selectors (comma-separated, first match wins). Override via env when
    // a webchat UI changes.
    selectors: {
        // env SELECTOR_INPUT > harness.config.json webchat.selectors.input >
        // the selected mode's input > the built-in default.
        input: (process.env.SELECTOR_INPUT
            || (MC.raw.webchat && MC.raw.webchat.selectors && MC.raw.webchat.selectors.input)
            || modeSel.input
            || 'textarea, div[contenteditable="true"]')
            .split(',').map((s) => s.trim()).filter(Boolean),
        send: ((MC.raw.webchat && MC.raw.webchat.selectors && MC.raw.webchat.selectors.send) || modeSel.send || 'button[aria-label="Send message"], button[aria-label*="Send" i], div[role="button"].ds-button--primary, div[role="button"].ds-button--filled, button[type="submit"], .send-button, [data-testid="send-button"]')
            .split(',').map((s) => s.trim()).filter(Boolean),
        message: ((MC.raw.webchat && MC.raw.webchat.selectors && MC.raw.webchat.selectors.message) || modeSel.message || 'model-response, [data-message-author-role="model"], .model-response-text, .response, .ds-markdown, .message, .chat-message')
            .split(',').map((s) => s.trim()).filter(Boolean),
        // The site's OWN "new chat" control. A fresh chat must be opened by
        // PRESSING this, not by navigating: Gemini redirects /app straight back to
        // the last conversation (verified - the URL stayed /app/<thread> and the old
        // rows were still rendered), so a goto silently reuses the old thread and
        // poisons both the model's context and the DOM read. See openNewChat().
        newChat: ((MC.raw.webchat && MC.raw.webchat.selectors && MC.raw.webchat.selectors.newChat) || modeSel.newChat || 'a[aria-label*="New chat" i], button[aria-label*="New chat" i], [data-test-id*="new-chat" i], [data-testid*="new-chat" i]')
            .split(',').map((s) => s.trim()).filter(Boolean),
        // What a CREATED conversation URL looks like for this mode, as a regex string.
        // Used to confirm a new chat actually got a thread. This must be per-mode: a
        // hardcoded DeepSeek shape (/a/chat/s/) was applied to every host and threw on
        // Gemini, where a fresh thread is /app/<hex> - so /handoff failed AFTER it had
        // already created and seeded the thread, and the gateway's own context handoff
        // was broken on Gemini the same way. Empty = unknown mode, judged generically.
        threadPattern: ((MC.raw.webchat && MC.raw.webchat.threadPattern) || modeSel.threadPattern || ''),
        // How long a mounted-but-EMPTY assistant row may stay empty before the send is
        // declared aborted. This is a TIME-TO-FIRST-TOKEN budget, not a whole-answer
        // budget. Gemini was falling through to the 12s default and failing mid-
        // generation: measured live, the tab rendered a complete run_bash tool call
        // while the harness had already thrown "response is empty after 12s". Gemini is
        // a thinking model like chatgpt/freebuff, which already had 180s/240s here.
        emptyGraceMs: (MC.pickNum('EMPTY_GRACE_MS', 'limits', 'emptyGraceMs') || modeSel.emptyGraceMs || 0),
    },
};

module.exports = cfg;
