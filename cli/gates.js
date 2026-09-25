'use strict';
//
// gates.js — the registry of webchat connections.
//
// A "gate" is one webchat the harness can send through: a site (Gemini, ChatGPT,
// DeepSeek…), the Chrome profile holding its login, the CDP port its browser is
// reachable on, and the gateway port that serves it. The owner asked for MORE THAN
// ONE, and for each to be selectable — so a gate is an object in a file, not the
// single set of values `.env` happened to hold.
//
// Everything here is file-backed and plain JSON so a user can read it, hand-edit it,
// or copy it between machines. There is no "the connection" any more: there is a list.
//
// Layout:
//   <stateDir>/gates.json          the registry
//   <stateDir>/chrome-profile-<id> one profile per gate, so two gates do not fight
//                                  over one profile (a persistent profile is
//                                  single-instance — that fight is a real bug we hit)
//
const fs = require('fs');
const path = require('path');
const d = require('./daemon.js');

// The sites we ship selectors for. `generic` is deliberately first-class and has NO
// selectors: the owner's model is that generic launches an EMPTY browser, the user
// logs in and navigates wherever they like, and the gate is whatever that tab is.
// That is how an unlisted webchat gets supported without us knowing its DOM.
const SITES = [
    {
        id: 'gemini',
        label: 'Gemini',
        url: 'https://gemini.google.com/app',
        note: 'Google Gemini. Sign in or it ignores the tool protocol entirely.',
    },
    {
        id: 'chatgpt',
        label: 'ChatGPT',
        url: 'https://chatgpt.com/',
        note: 'ChatGPT. Log in for the tool protocol to be followed.',
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        url: 'https://chat.deepseek.com/',
        note: 'DeepSeek. The reference lane: has deliberate anti-bot send spacing.',
    },
    {
        id: 'kimi',
        label: 'Kimi',
        url: 'https://www.kimi.com/',
        note: 'Kimi (Moonshot).',
    },
    {
        id: 'notegpt',
        label: 'NoteGPT',
        url: 'https://notegpt.io/ai-chat',
        note: 'NoteGPT. Selectors are tested; its composer resists being cleared and its SEND is gated site-side, so expect to approve a hand-driven send before trusting it.',
    },
    {
        id: 'freebuff',
        label: 'Freebuff',
        url: 'https://freebuff.com/chat',
        note: 'Freebuff (GLM 5.3 Flash, free). Fresh chats default to the highest reasoning effort, which makes a reply take minutes — set effort to Low in the tab.',
    },
    {
        id: 'claude',
        label: 'Claude (claude.ai)',
        url: 'https://claude.ai/new',
        note: 'Claude on the web. Log in first. This is the webchat, not Claude Code — the local agent CLI is a separate option in the harness list.',
    },
    {
        id: 'generic',
        label: 'Generic (any site)',
        url: '',
        note: 'Opens an EMPTY browser. You log in and navigate to any site, then mark it connected.',
        generic: true,
    },
];

function siteById(id) {
    return SITES.find((s) => s.id === id) || null;
}

// Which site does a URL look like? Used when a gate is created from a live tab, so
// the user does not have to tell us what they already have open.
function siteForUrl(url) {
    const u = String(url || '');
    if (/gemini\.google\.com/.test(u)) return 'gemini';
    if (/chatgpt\.com|chat\.openai\.com/.test(u)) return 'chatgpt';
    if (/chat\.deepseek\.com/.test(u)) return 'deepseek';
    if (/kimi\.com|kimi\.ai|moonshot/.test(u)) return 'kimi';
    if (/notegpt\.io/.test(u)) return 'notegpt';
    if (/freebuff\.com/.test(u)) return 'freebuff';
    if (/claude\.ai/.test(u)) return 'claude';
    return 'generic';
}

const registryFile = () => path.join(d.stateDir(), 'gates.json');

function read() {
    const f = registryFile();
    if (!fs.existsSync(f)) return { gates: [], active: null };
    try {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (!parsed || !Array.isArray(parsed.gates)) return { gates: [], active: null };
        return { gates: parsed.gates, active: parsed.active || null };
    } catch {
        // A corrupt registry must not take the CLI down — say so and start clean,
        // rather than throwing on every screen that reads a gate.
        return { gates: [], active: null, error: 'gates.json is not valid JSON — starting empty' };
    }
}

function write(state) {
    d.ensureStateDir();
    const f = registryFile();
    const tmp = `${f}.tmp`;
    // Write+rename: a truncated registry would silently drop every gate, and these
    // are the user's connections. An atomic replace cannot half-write.
    fs.writeFileSync(tmp, JSON.stringify({ gates: state.gates, active: state.active }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    return state;
}

// A stable, human-readable id. Derived from the site plus a counter so two Gemini
// gates are `gemini` and `gemini-2` rather than a hash the user cannot recognise.
function nextId(gates, siteId) {
    const base = String(siteId || 'gate').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'gate';
    if (!gates.some((g) => g.id === base)) return base;
    let n = 2;
    while (gates.some((g) => g.id === `${base}-${n}`)) n++;
    return `${base}-${n}`;
}

// Ports are CHOSEN, not derived. A fixed base (8181/9281, or the earlier 8081/9225)
// collides with whatever else is running on the machine — on this box 8081-8083 are
// oculus gateways and 9225-9230 their chromes, so a derived port handed out a lane
// that belonged to another stack and a model request came back answered by the wrong
// browser. Asking the OS for a free port makes that impossible without the user
// having to know or care which numbers are taken.
// The port helpers live in daemon.js — this module requires that one, so the other
// direction would be a cycle. Re-exported here so every existing G.freePortPair() caller
// keeps working and there is still exactly one implementation.
const freePort = (...a) => d.freePort(...a);
const isPortFree = (...a) => d.isPortFree(...a);
const freePortPair = (...a) => d.freePortPair(...a);

function add({ site, label, url, cdpPort, gatewayPort, profile }) {
    const state = read();
    const siteId = site || siteForUrl(url);
    const s = siteById(siteId) || siteById('generic');
    const id = nextId(state.gates, siteId);
    const gate = {
        id,
        label: label || `${s.label}${id.match(/-(\d+)$/) ? ' ' + id.match(/-(\d+)$/)[1] : ''}`,
        site: siteId,
        url: url || s.url || '',
        // Each gate gets its OWN profile by default. Two gates sharing one is the
        // single-instance fight: the second launch fails with "browser already
        // running for this profile" and the user sees a dead button.
        profile: profile || path.join(d.stateDir(), `chrome-profile-${id}`),
        // Allocate ports instead of defaulting to 0. The CLI's add-gate screen passes
        // them explicitly, but the MCP tool (webchat_gate_add) did not, so an agent-created
        // gate was stored as 0/0 and `webchat connect` dialled CDP :0 — "browser not
        // answering" on a browser that was open and logged in the whole time.
        // Ports MUST be supplied by the caller (the CLI screen picks free ones) or the
        // gate is unusable: the old default of 0 made 'webchat connect' dial CDP :0.
        cdpPort: Number(cdpPort) || 0,
        gatewayPort: Number(gatewayPort) || 0,
        // A gate is only usable once the USER has confirmed the browser is logged in.
        // We cannot detect a login reliably — a signed-out Gemini still renders an
        // input box — so this flag is set by the user, deliberately, and is the only
        // thing `connected` means.
        connected: false,
        createdAt: new Date().toISOString(),
    };
    state.gates.push(gate);
    write(state);
    return gate;
}

function update(id, patch) {
    const state = read();
    const gate = state.gates.find((g) => g.id === id);
    if (!gate) return null;
    Object.assign(gate, patch);
    write(state);
    return gate;
}

function remove(id) {
    const state = read();
    const before = state.gates.length;
    state.gates = state.gates.filter((g) => g.id !== id);
    if (state.active === id) state.active = null;
    write(state);
    return state.gates.length < before;
}

function get(id) {
    return read().gates.find((g) => g.id === id) || null;
}

function setActive(id) {
    const state = read();
    state.active = id && state.gates.some((g) => g.id === id) ? id : null;
    write(state);
    return state.active;
}

// Does this gate's browser answer on its CDP port? Async because it is a network
// probe; the caller decides what to do when it is false.
async function probe(gate) {
    const out = { running: false, tabs: 0, liveTabUrl: null };
    if (!gate || !gate.cdpPort) return out;
    try {
        const alive = await d.cdpAlive(gate.cdpPort);
        out.running = Boolean(alive && alive.up);
        if (out.running && Array.isArray(alive.pages)) {
            out.tabs = alive.pages.length;
            const match = alive.pages.find((p) => gate.url && String(p.url).includes(new URL(gate.url).host));
            out.liveTabUrl = (match || alive.pages.find((p) => !String(p.url).startsWith('about:')) || {}).url || null;
        }
    } catch { /* unreachable port is just "not running" */ }
    return out;
}

// ── is this webchat ACTUALLY usable right now? ──────────────────────────────
//
// `connected` is a flag the user set once, when they confirmed a tab. It goes stale: a
// session expires, a profile gets signed out, the tab is closed. Live, DeepSeek was
// signed out while the CLI still listed it as a connected webchat and offered it in the
// launch, so the agent came up pointed at a tab that could never answer.
//
// So the flag is EVIDENCE, not a memory: a gate is live only when its browser is
// answering, a tab for the site exists, that tab has a composer, and the page does not
// carry sign-in copy. That is the same rule browser.js uses before it sends.
async function live(gate) {
    const out = { live: false, why: 'no browser', url: null };
    if (!gate || !gate.cdpPort) return out;
    let browser = null;
    try {
        const targets = await d.cdpTargets(gate.cdpPort);
        if (!targets.ok || !targets.pages.length) return out;
        let host = null;
        try { host = gate.url ? new URL(gate.url).host : null; } catch { /* opaque url */ }
        const page = targets.pages.find((p) => host && String(p.url).includes(host))
            || targets.pages.find((p) => !String(p.url).startsWith('about:'))
            || targets.pages[0];
        out.url = page.url;

        const puppeteer = require('puppeteer-core');
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${gate.cdpPort}`, defaultViewport: null });
        const pages = await browser.pages();
        const tab = pages.find((pg) => pg.url() === page.url) || pages[0];
        if (!tab) { out.why = 'no tab'; return out; }

        const seen = await tab.evaluate(() => {
            const text = document.body ? (document.body.innerText || '') : '';
            const top = text.slice(0, 1200);
            return {
                signedOut: /\b(sign in|log in|sign up to|log in to get answers|sign in to save activity)\b/i.test(top),
                hasInput: !!document.querySelector('div[contenteditable="true"], textarea, rich-textarea'),
                url: location.href,
            };
        });
        out.url = seen.url;
        if (!seen.hasInput) { out.why = 'no composer (not signed in?)'; return out; }
        if (seen.signedOut) { out.why = 'signed out'; return out; }
        return { live: true, why: 'signed in', url: seen.url };
    } catch (e) {
        out.why = e.message;
        return out;
    } finally {
        try { if (browser) await browser.disconnect(); } catch { /* already gone */ }
    }
}

// The dashboard redraws every couple of seconds and connecting to a browser is not free,
// so a check is cached. `maxAgeMs` of 0 forces a fresh one.
const _liveCache = new Map();   // gate id -> { at, state }

async function liveCached(gate, maxAgeMs = 30000) {
    const key = gate.id || `${gate.cdpPort}`;
    const hit = _liveCache.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.state;
    const state = await live(gate);
    _liveCache.set(key, { at: Date.now(), state });
    return state;
}

// Re-check every gate and PERSIST the result, so the stored flag stops being a memory and
// starts being what was last observed. Returns the refreshed registry.
async function refresh(reg, maxAgeMs = 30000) {
    const r = reg || read();
    const out = [];
    for (const g of r.gates || []) {
        const state = await liveCached(g, maxAgeMs);
        out.push({ ...g, connected: Boolean(state.live), notConnectedWhy: state.live ? null : state.why });
    }
    const next = { ...r, gates: out };
    try { write(next); } catch { /* a read-only state dir must not break the dashboard */ }
    return next;
}

// Only the gates that are usable RIGHT NOW. This is what a launch selection must be
// built from: offering a webchat whose tab cannot answer is offering a broken agent.
async function liveGates(maxAgeMs = 30000) {
    const r = await refresh(undefined, maxAgeMs);
    return (r.gates || []).filter((g) => g.connected);
}

module.exports = {
    freePort,
    freePortPair,
    isPortFree,
    SITES,
    siteById,
    siteForUrl,
    read,
    write,
    add,
    update,
    remove,
    get,
    setActive,
    probe,
    live,
    liveCached,
    refresh,
    liveGates,
    registryFile,
};
