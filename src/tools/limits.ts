'use strict';
//
// limits.js — per-tool limits, each one either a HARD BAN or an ASK.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Switching a tool off is all-or-nothing, and the interesting cases are not
// all-or-nothing. `run_bash` is useful right up until the command touches the network;
// `edit_file` is fine inside the project and not fine inside .env. A limit is that
// distinction, attached to the tool it constrains:
//
//     tools.limits = {
//       run_bash:  [ { match: "curl ", enforce: "ban" },
//                    { match: "rm -rf", enforce: "ask" } ],
//       edit_file: [ { match: "/.env", enforce: "ban" } ]
//     }
//
// `match` is tested against the tool's own arguments, so one entry covers every way the
// model can spell the same intent through that tool (a path in `path`, a command in
// `command`, a URL inside a longer string).
//
// ── THE TWO ENFORCEMENTS ────────────────────────────────────────────────────
//   ban  — refused outright. The model is told it is banned and told not to rephrase it.
//   ask  — refused UNTIL a human approves, regardless of the permission mode. This is
//          the stronger of the two in practice: `yolo` mode exists to skip prompting,
//          and a limit marked `ask` is precisely the one that must not be skipped. The
//          gateway has no approval prompt of its own, so the refusal is the message the
//          human sees; nothing happens until they say so.
//
// A `ban` is checked first, so a tool call matching both is banned rather than asked.

const MC = (() => {
    try { return require('../core/master_config'); } catch { return null; }
})();

export interface ToolLimit {
    match: string;
    enforce: string;
    note: string;
}

export interface LimitVerdict {
    allowed: boolean;
    enforce?: string;
    pattern?: string;
    note?: string;
}

const ENFORCEMENTS = ['ban', 'ask'];

// Limits are read once and cached; a config edit takes effect on the next gateway start,
// which is the same contract every other setting here has.
let _cache: Record<string, ToolLimit[]> | null = null;

function loadLimits(): Record<string, ToolLimit[]> {
    const out: Record<string, ToolLimit[]> = {};
    try {
        if (!MC) return out;
        let raw = MC.pick('TOOLS_LIMITS', 'tools', 'limits');
        // `pick` returns an env var as a STRING, and undefined when the file has no such
        // key. Both are normal here: no limits is the default state.
        if (raw === undefined || raw === null) return out;
        if (typeof raw === 'string') {
            const s = raw.trim();
            if (!s) return out;
            try { raw = JSON.parse(s); } catch { return out; }
        }
        if (!raw || typeof raw !== 'object') return out;
        for (const [tool, list] of Object.entries(raw as Record<string, unknown>)) {
            if (!Array.isArray(list)) continue;
            const cleaned: ToolLimit[] = [];
            for (const rawLimit of list as unknown[]) {
                if (!rawLimit || typeof rawLimit !== 'object') continue;
                const l = rawLimit as Record<string, unknown>;
                const match = String(l.match == null ? '' : l.match);
                if (!match.trim()) continue;              // an empty match would catch everything
                const enforce = ENFORCEMENTS.includes(String(l.enforce)) ? String(l.enforce) : 'ban';
                cleaned.push({ match, enforce, note: l.note ? String(l.note) : '' });
            }
            if (cleaned.length) out[String(tool)] = cleaned;
        }
    } catch {
        // A broken config must not lock every tool. An unreadable limit list is reported
        // by the Tools screen; the gateway keeps working.
        return {};
    }
    return out;
}

function limitsFor(toolName: unknown): ToolLimit[] {
    if (!_cache) _cache = loadLimits();
    return _cache[String(toolName)] || [];
}

function resetCache(): void { _cache = null; }

// A `/re/` spelling is a regular expression; anything else is a plain substring. Substring
// is the default because it cannot fail to compile and matches how people write these.
function matches(pattern: unknown, text: unknown): boolean {
    const t = String(text == null ? '' : text);
    const m = /^\/(.*)\/([gimsuy]*)$/.exec(String(pattern));
    if (m) {
        try { return new RegExp(m[1], m[2].replace('g', '')).test(t); } catch { return false; }
    }
    return t.toLowerCase().includes(String(pattern).toLowerCase());
}

// Everything the model is passing in, flattened, so a limit can be written against the
// value it cares about without knowing which argument carries it.
function argsText(args: unknown): string {
    if (args == null) return '';
    if (typeof args === 'string') return args;
    const parts: string[] = [];
    const walk = (v: unknown): void => {
        if (v == null) return;
        if (typeof v === 'string') { parts.push(v); return; }
        if (typeof v === 'number' || typeof v === 'boolean') { parts.push(String(v)); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (typeof v === 'object') { Object.values(v as Record<string, unknown>).forEach(walk); }
    };
    walk(args);
    return parts.join(' ');
}

// The decision for one tool call. Returns what to do AND which limit made the call, so the
// refusal can name it instead of being a generic "denied".
function checkLimits(toolName: unknown, args: unknown): LimitVerdict {
    const list = limitsFor(toolName);
    if (!list.length) return { allowed: true };
    const text = argsText(args);
    const hit = list.find((l) => l.enforce === 'ban' && matches(l.match, text))
        || list.find((l) => matches(l.match, text));
    if (!hit) return { allowed: true };
    return {
        allowed: false,
        enforce: hit.enforce,
        pattern: hit.match,
        note: hit.note,
    };
}

// What the model is told. It has to say the action is blocked AND that rewording is not
// the answer, because a model that is refused once will otherwise paraphrase until it
// slips past.
function refusalMessage(toolName: unknown, verdict: LimitVerdict): string {
    const why = `matches the limit "${verdict.pattern}"`;
    if (verdict.enforce === 'ban') {
        return `${toolName} is BANNED for this call: the arguments ${why}. `
            + 'This is a limit the user set, it applies in every permission mode, and rewording '
            + 'the same action to get around it is not allowed. Choose a different approach, or '
            + 'tell the user what you need and why.';
    }
    return `${toolName} needs the user's APPROVAL before it can run: the arguments ${why}. `
        + 'This limit asks regardless of the permission mode, so it is not a mode you can switch '
        + 'away. Stop and ask the user to approve this specific action, then continue.';
}

export = {
    ENFORCEMENTS,
    loadLimits,
    limitsFor,
    checkLimits,
    refusalMessage,
    argsText,
    matches,
    resetCache,
};
