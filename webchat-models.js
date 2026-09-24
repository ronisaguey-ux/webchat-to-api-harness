'use strict';
//
// webchat-models.js — ONE place that knows which models a webchat offers and which
// toggles exist inside it, and turns that into a model id an agentic harness can pick.
//
// ── THE IDEA ────────────────────────────────────────────────────────────────
// A webchat's real configuration lives in its UI: DeepSeek has DeepThink and Search
// chips, ChatGPT has a Think toggle, Freebuff has a reasoning-effort selector. An
// agentic harness (Claude Code, opencode, Codex) can only choose a MODEL — it has no
// concept of "flip a chip". So every toggle COMBINATION is published as its own model
// id, and choosing that id makes the gateway set the chips over CDP before it sends:
//
//     webchat/deepseek                     default
//     webchat/deepseek/search              Search on
//     webchat/deepseek/deepthink           DeepThink on
//     webchat/deepseek/deepthink+search    both
//
// The user changes configuration by picking a different model. Nothing else.
//
// ── NEW CHATS ───────────────────────────────────────────────────────────────
// Some toggles only take effect on a FRESH conversation (a chip that is baked into
// the thread's mode). When a toggle sets `requiresNewChat`, the gateway summarises
// the thread so far, opens a new chat with the toggle applied, and injects that
// summary as the first message — so the choice does not cost the user their context.
//
// ── VERIFICATION ────────────────────────────────────────────────────────────
// `verified` is per site and means the chips/selectors were OBSERVED in a live DOM.
// Nothing here is invented: an unverified entry carries the probe it still needs.
// A site whose UI could not be read is listed with toggles: [] rather than guesses.

// A toggle: an in-page control that changes how the webchat answers.
//   id        — appears in the model id
//   label     — what the user sees in the model list
//   ui        — the text/selector that identifies the real control in the page
//   kind      — chip | toggle | select
//   default   — state the harness leaves it in when the id does not mention it
//   requiresNewChat — the control only applies to a fresh conversation
const SITES = {
    deepseek: {
        label: 'DeepSeek',
        verified: '2026-09-24',
        note: 'Chips are buttons labelled by their own text: DeepThink / Search.',
        toggles: [
            { id: 'search', label: 'Search', ui: 'Search', kind: 'chip', default: false, requiresNewChat: false },
            { id: 'deepthink', label: 'DeepThink', ui: 'DeepThink', kind: 'chip', default: true, requiresNewChat: false },
        ],
    },
    chatgpt: {
        label: 'ChatGPT',
        verified: null,
        note: 'The Think toggle was seen as aria-pressed in earlier work; the chip row changes often, so this needs one live read before it is trusted.',
        toggles: [
            { id: 'think', label: 'Think', ui: 'Think', kind: 'toggle', default: false, requiresNewChat: true },
        ],
    },
    gemini: {
        label: 'Gemini',
        verified: null,
        note: 'Mode tabs (Instant/Expert) plus DeepThink/Search chips. The tabs disappeared in the current UI — DeepThink is the real signal.',
        toggles: [
            { id: 'deepthink', label: 'DeepThink', ui: 'DeepThink', kind: 'chip', default: true, requiresNewChat: false },
            { id: 'search', label: 'Search', ui: 'Search', kind: 'chip', default: false, requiresNewChat: false },
        ],
    },
    kimi: {
        label: 'Kimi',
        verified: '2026-09-24',
        note: 'Probed live on CDP :9230. Model picker is div.current-model[data-testid="model-select-trigger"], currently "Instant / Standard".',
        toggles: [],
        models: [
            { id: 'instant', label: 'Instant', ui: 'Instant' },
            { id: 'thinking', label: 'Thinking', ui: 'Thinking' },
        ],
    },
    freebuff: {
        label: 'Freebuff',
        verified: null,
        note: 'Has a reasoning-effort selector that DEFAULTS TO MAX on every new chat, which is why a reply takes minutes. Low is the fast setting; it resets, so it has to be set on each fresh chat.',
        toggles: [
            { id: 'effortlow', label: 'Effort: Low (fast)', ui: 'Low', kind: 'select', default: false, requiresNewChat: true },
            { id: 'effortmax', label: 'Effort: Max (slow)', ui: 'Max (model default)', kind: 'select', default: true, requiresNewChat: true },
        ],
    },
    notegpt: {
        label: 'NoteGPT',
        verified: null,
        note: 'Composer is div[contenteditable=true]; the SEND is gated site-side and has never been made to commit. No toggle set read yet.',
        toggles: [],
    },
    claude: {
        label: 'Claude (claude.ai)',
        verified: null,
        note: 'claude.ai served a Cloudflare interstitial, so the DOM could not be read. Toggle set unknown — do not guess it.',
        toggles: [],
    },
    generic: {
        label: 'Generic',
        verified: null,
        note: 'No selectors by design — the tab is whatever the user navigated to, so there is nothing to toggle.',
        toggles: [],
    },
};

/** All toggle combinations for a site, empty set first. DeepSeek gives the 4 ids. */
function combinations(site) {
    const toggles = (SITES[site] && SITES[site].toggles) || [];
    const out = [[]];
    for (const t of toggles) {
        for (const existing of out.slice()) out.push([...existing, t]);
    }
    // default first, then singles in declared order, then the longer mixtures.
    out.sort((a, b) => (a.length - b.length) || (a[0] && b[0] ? toggles.indexOf(a[0]) - toggles.indexOf(b[0]) : 0));
    return out;
}

/** The model ids a site publishes, e.g. webchat/deepseek/deepthink+search */
function modelIdsFor(site) {
    const s = SITES[site];
    if (!s) return [];
    const bases = s.models && s.models.length ? s.models.map((m) => m.id) : [null];
    const ids = [];
    for (const base of bases) {
        for (const combo of combinations(site)) {
            const parts = [site];
            if (base) parts.push(base);
            if (combo.length) parts.push(combo.map((t) => t.id).join('+'));
            ids.push(`webchat/${parts.join('/')}`);
        }
    }
    return ids;
}

/** Every model id across every site — what /v1/models advertises. */
function allModelIds() {
    return Object.keys(SITES).flatMap((site) => modelIdsFor(site));
}

/**
 * Parse a model id back into the site, base model and toggle set.
 *
 * Unknown toggles are REPORTED, not silently dropped: a harness asking for a toggle
 * this build does not know must get an error, or it believes it changed something.
 */
function parse(modelId) {
    const m = String(modelId || '').trim();
    if (!m.startsWith('webchat/')) return null;
    const parts = m.slice('webchat/'.length).split('/').filter(Boolean);
    if (!parts.length) return null;
    const site = parts.shift();
    const s = SITES[site];
    if (!s) return { site: null, unknownSite: site, base: null, toggles: [], unknown: [], requiresNewChat: false };

    let base = null;
    let togglePart = null;
    if (parts.length === 1) {
        // could be a base model (kimi/instant) or a toggle combo (deepseek/search)
        const knownBase = (s.models || []).find((x) => x.id === parts[0]);
        if (knownBase) base = knownBase.id;
        else togglePart = parts[0];
    } else if (parts.length >= 2) {
        base = parts[0];
        togglePart = parts[1];
    }

    const want = togglePart ? togglePart.split('+').filter(Boolean) : [];
    const known = (s.toggles || []).map((t) => t.id);
    const unknown = want.filter((w) => !known.includes(w));
    const toggles = (s.toggles || []).filter((t) => want.includes(t.id));
    return {
        site,
        base,
        toggles,
        unknown,
        requiresNewChat: toggles.some((t) => t.requiresNewChat),
        label: describe(site, base, toggles),
    };
}

function describe(site, base, toggles) {
    const s = SITES[site];
    if (!s) return site;
    const bits = [s.label];
    if (base) bits.push(base);
    if (toggles && toggles.length) bits.push(toggles.map((t) => t.label).join(' + '));
    else bits.push('default');
    return bits.join(' — ');
}

/** The desired state of every toggle for a site. Unmentioned toggles use `default`. */
function toggleStateFor(site, chosen) {
    const s = SITES[site];
    if (!s) return {};
    const picked = new Set((chosen || []).map((t) => t.id));
    const state = {};
    for (const t of s.toggles || []) state[t.id] = picked.has(t.id) ? true : (t.default === true);
    return state;
}

module.exports = {
    SITES,
    combinations,
    modelIdsFor,
    allModelIds,
    parse,
    describe,
    toggleStateFor,
};
