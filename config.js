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
    webchatUrl: MC.pickBool('WEBCHAT_URL_OVERRIDE', 'webchat', 'urlOverride') === true
        ? (MC.pickStr('WEBCHAT_URL', 'webchat', 'url') || MODE.url || 'https://chat.deepseek.com')
        : (chat.url || MC.pickStr('WEBCHAT_URL', 'webchat', 'url') || MODE.url || 'https://chat.deepseek.com'),
    // Second-instance tab matching: when set, pick the tab whose URL CONTAINS
    // this substring instead of first-tab-with-matching-origin — lets two
    // instances share one browser, each pinned to its own thread.
    tabUrlSubstring: MC.pickStr('TAB_URL_SUBSTRING', 'webchat', 'tabUrlSubstring') || MODE.tabUrlSubstring || null,
    // Conversation mode (08-12): accept plain-text replies as the final answer
    // instead of demanding fenced tool JSON — for personal threads whose model
    // talks like a friend. Tool calls still work when the model makes them.
    allowPlainText: MC.pickBool('ALLOW_PLAIN_TEXT', 'features', 'allowPlainText') === true,
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

    // 09-13 EXPERIMENTAL — reasoning-loop detection. Off by default; see the
    // README "Anti-spiral" section. NARRATION=true also relaxes the detector so
    // narration is never mistaken for a loop.
    antiSpiral: MC.pickBool('ANTI_SPIRAL', 'features', 'antiSpiral') === true,

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
    },
};

module.exports = cfg;
