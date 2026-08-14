require('dotenv').config();

// chat.js overrides (paste your tab URL there — it wins over .env)
let chat = {};
try {
    chat = require('./chat.js');
} catch {
    /* chat.js missing — fall back to .env */
}

const cfg = {
    // Server
    host: process.env.HOST || '127.0.0.1',
    port: parseInt(process.env.PORT) || 8080,

    // Webchat target — WEBCHAT_URL_OVERRIDE=true lets a second instance
    // (different PORT) pin its own thread even though chat.js exists
    // (chat.js normally wins). Multi-instance pattern 08-12.
    webchatUrl: process.env.WEBCHAT_URL_OVERRIDE === 'true'
        ? process.env.WEBCHAT_URL
        : (chat.url || process.env.WEBCHAT_URL || 'https://chat.deepseek.com'),
    // Second-instance tab matching: when set, pick the tab whose URL CONTAINS
    // this substring instead of first-tab-with-matching-origin — lets two
    // instances share one browser, each pinned to its own thread.
    tabUrlSubstring: process.env.TAB_URL_SUBSTRING || null,
    // Conversation mode (08-12): accept plain-text replies as the final answer
    // instead of demanding fenced tool JSON — for personal threads whose model
    // talks like a friend. Tool calls still work when the model makes them.
    allowPlainText: process.env.ALLOW_PLAIN_TEXT === 'true',
    headless: process.env.HEADLESS === 'true',
    modelName: process.env.MODEL_NAME || 'deepseek webchat',
    // 08-13 MULTI-SITE: env FIRST — chat.js carries a hardcoded 9224 URL, so
    // CDP_WS_URL was ignored and no instance could target the 9223 GUI
    // browser (qwen/kimi/gemini logged-in tabs).
    cdpWsUrl: process.env.CDP_WS_URL || chat.cdpWsUrl || null,
    // 08-13 VIEWPORT PIN: on WM-less X sessions Chrome renderers can freeze
    // at the launch-time size (all 9223 GUI tabs were stuck 800x600 inside
    // 1920x1034 windows — resize events never arrive, page rendered
    // quarter-size with the window surface around it). When set, the gateway
    // pins the layout viewport via Emulation.setDeviceMetricsOverride right
    // after attaching to the tab. Headless instances leave it unset.
    viewportW: parseInt(process.env.VIEWPORT_W) || 0,
    viewportH: parseInt(process.env.VIEWPORT_H) || 0,
    // 08-14 OPTIMIZATION (owner's performance guide): network-level asset
    // blocking — images/fonts/media are aborted at the CDP layer (RAM +
    // bandwidth win on heavy sites like gemini; document/script/xhr/fetch/
    // websocket always pass). Stylesheets blocked only when BLOCKED_CSS=1
    // (deepseek SPAs are stable; gemini's layout is fragile — leave off).
    // BLOCKED_URLS_EXTRA = comma-separated extra glob patterns.
    blockedUrls: (process.env.BLOCKED_URLS_EXTRA ? process.env.BLOCKED_URLS_EXTRA.split(',') : [])
        .concat(process.env.BLOCKED_CSS === 'true' ? ['*.css*'] : [])
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
    contextHandoffEnabled: process.env.CONTEXT_HANDOFF_ENABLED !== 'false',
    contextHandoffThreshold: parseInt(process.env.CONTEXT_HANDOFF_THRESHOLD) || 2000000,
    handoffFile: process.env.HANDOFF_FILE || '/home/roni/Roni_workspace/handoff_to_new_chat.md',

    // Behaviour
    timeout: parseInt(process.env.TIMEOUT) || 1800000, // 08-13 EVENING: run-until-done tasks + 6s send spacing + narration exceed 180s routinely; the 180s cap timed out mid-task and its crash path killed the process (now guarded). 08-14: 10 min still too short — the webchat cogitated SILENTLY 11 min on 'add EVERYTHING' (08-13 22:5x) and BOTH the gateway timeout and the client stream-idle watchdog fired. 30 min default; the SSE keepalive (server.js) keeps clients alive through it.
    toolContextWindow: parseInt(process.env.TOOL_CONTEXT_WINDOW) || 30000, // Claude Code's tool list + schemas is ~20K chars
    loginWaitMs: (parseInt(process.env.LOGIN_WAIT_SECONDS) || 300) * 1000,
    maxToolRounds: parseInt(process.env.MAX_TOOL_ROUNDS) || 40, // always-tool mode: feature work spans many rounds; yap-rejections burn 1-2 rounds per tool call (08-12: 20 ran out mid-task at read_file(App.jsx))
    skipBrowser: process.env.SKIP_BROWSER === 'true',

    // Security
    apiToken: process.env.API_TOKEN || null,
    bashAllowed: process.env.BASH_ALLOWED === 'true',
    execTimeoutMs: parseInt(process.env.EXEC_TIMEOUT_MS) || 10000,
    execMaxBuffer: 4 * 1024 * 1024,

    // Session persistence
    cookieFile: process.env.COOKIE_FILE || '.cookies.json',

    // Selectors (comma-separated, first match wins). Override via env when
    // a webchat UI changes.
    selectors: {
        input: (process.env.SELECTOR_INPUT || 'textarea, div[contenteditable="true"]')
            .split(',').map((s) => s.trim()).filter(Boolean),
        send: (process.env.SELECTOR_SEND || 'div[role="button"].ds-button--primary, div[role="button"].ds-button--filled, button[type="submit"], .send-button, [data-testid="send-button"], button[aria-label="Send message"], div[role="button"]')
            .split(',').map((s) => s.trim()).filter(Boolean),
        message: (process.env.SELECTOR_MESSAGE || '.message, .chat-message, .response, [data-message-author-role], .ds-markdown, .model-response-text, .user-query, message-content')
            .split(',').map((s) => s.trim()).filter(Boolean),
    },
};

module.exports = cfg;
