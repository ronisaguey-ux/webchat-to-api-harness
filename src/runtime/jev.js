'use strict';
// ── Jev interceptor client ──────────────────────────────────────────────────
// Jev (TypeSafe) is a DECISION model: you send state + a map of typed questions
// and get typed answers with probabilities back. No prose, ever. The answer set
// is fixed before the request leaves, so it cannot invent an option.
//
// Endpoint notes (all learned by calling it, 2026-09-22):
//   POST https://openrouter.ai/api/alpha/decisions
//   model "typesafe/jev-1.13"
//   questions is a RECORD keyed by question id, NOT an array.
//   criteria shape depends on type:
//     choice -> record of { optionId: description }
//     score  -> array of levels, lowest -> highest
//     noul   -> record keyed by the boolean states { true: .., false: .. }
//   A wrong criteria shape for a choice does NOT error: Jev answers with the
//   literal key name as the choice. Never trust a choice whose id you did not
//   declare -- that is checked below.
//
// This client FAILS OPEN: any error, timeout or malformed reply returns
// { ok:false, reason }, and the caller proceeds as if Jev were not configured.
// A decision layer that can break the path it guards is worse than none.

const DECISIONS_URL = process.env.JEV_URL || 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';
const JEV_TIMEOUT_MS = parseInt(process.env.JEV_TIMEOUT_MS || '4000', 10);
const JEV_ENABLED = String(process.env.JEV_ENABLED || 'true').toLowerCase() !== 'false';

function apiKey() {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
    if (process.env.OPENROUTER_KEY_FILE) {
        try { return require('fs').readFileSync(process.env.OPENROUTER_KEY_FILE, 'utf-8').trim(); } catch { return ''; }
    }
    try { return require('fs').readFileSync(process.env.HOME + '/.claude/openrouter.token', 'utf-8').trim(); } catch { return ''; }
}

function ok(reason) { return { ok: false, reason }; }

// Validate that a choice answer is one of the options WE declared.
function assertDeclaredChoices(q, ans) {
    if (!q || q.type !== 'choice') return;
    const declared = Object.keys(q.criteria || {});
    if (!declared.includes(ans.choice)) {
        throw new Error(`Jev returned an undeclared choice "${ans.choice}" (declared: ${declared.join(', ')})`);
    }
}

async function decide(state, questions, opts = {}) {
    if (!JEV_ENABLED) return ok('disabled');
    const key = apiKey();
    if (!key) return ok('no api key');
    if (!state || !questions || !Object.keys(questions).length) return ok('empty request');

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs || JEV_TIMEOUT_MS);
    try {
        const r = await fetch(DECISIONS_URL, {
            method: 'POST',
            signal: ctl.signal,
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: opts.model || JEV_MODEL, state, questions }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) return ok(`http ${r.status}: ${JSON.stringify(body && body.error || {}).slice(0, 200)}`);
        const answers = (body && body.answers) || {};
        for (const [qid, q] of Object.entries(questions)) {
            if (!answers[qid]) return ok(`question "${qid}" not answered`);
            assertDeclaredChoices(q, answers[qid]);
        }
        return { ok: true, answers, usage: body.usage || null, raw: body };
    } catch (e) {
        return ok(e.name === 'AbortError' ? `timeout after ${opts.timeoutMs || JEV_TIMEOUT_MS}ms` : String(e.message || e));
    } finally {
        clearTimeout(t);
    }
}

// ── The decision this harness actually needs ────────────────────────────────
// "Is this reply a usable answer?" -- the Noul that maps onto the classes we
// already pay for: empty / stale row / prompt echo / think-only / no edits.
// Returns { ok, usable:boolean|null, probability, reason }.
async function replyIsUsable(replyText, contract, opts = {}) {
    const text = String(replyText || '').slice(0, 8000);   // 32k ctx; stay well inside
    const d = await decide(
        `A caller asked a webchat for a reply satisfying this contract:\n${String(contract || '').slice(0, 2000)}\n\n` +
        `The reply received was:\n${text || '(EMPTY REPLY)'}`,
        {
            usable: {
                type: 'noul',
                instructions: 'Does this reply give the caller at least one edit it can actually apply?',
                // WORDING IS THE WHOLE ANSWER. Measured on {"edits":[]}:
                //   vague criterion ("non-empty", "contains the answer") -> noul 0.89, i.e. WRONG
                //   this criterion, which NAMES the failure it tests for     -> noul 0.02, correct
                //   a real edit                 -> 0.98
                //   the request echoed back     -> 0.03
                // The criterion must name the exact thing that makes the reply useless.
                criteria: {
                    true: 'the edits array contains one or more entries, each with a file, an old_string and a new_string',
                    false: 'the edits array is empty, the reply has no edits array, or the reply is the request echoed back',
                },
            },
        },
        opts
    );
    if (!d.ok) return { ok: false, usable: null, reason: d.reason };
    const p = d.answers.usable.noul;
    return { ok: true, usable: p >= (opts.threshold ?? 0.5), probability: p, reason: `p=${p}` };
}

module.exports = { decide, replyIsUsable, DECISIONS_URL, JEV_MODEL };
