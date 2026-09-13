'use strict';

// ── Anti-spiral for the webchat-to-API harness ──────────────────────────────
// A webchat model can collapse into a reasoning loop: the same sentence, line or
// short "Let me go." / "Let me read." tic repeated until the round budget runs
// out. The caller then sees "did not submit a final answer within the round
// budget" and all the work is lost.
//
// This module detects that loop in the model's reply, so the gateway can stop
// feeding the tab, put a warning at the TOP of the answer, and send one redirect
// telling the model to stop narrating and do the work.
//
// Detection is ported from the opencode anti-spiral plugin (v3) — the same five
// signatures, because they were tuned against real spirals:
//   1. the same sentence (>30 chars) twice in a row
//   2. the same prose line (>= 6 words) three or more times
//   3. the stall tic: a line of <= 4 words ("Let me go.", "OK.") on its own >= 4x
//   4. n-gram dominance over the whole message (n = 3..8)
//   5. tail dominance: the END of the message has degenerated into one unit
// Code fences, tables and tool output are stripped before measuring, because
// those repeat lines legitimately.
//
// NARRATION IS NOT A SPIRAL. A caller using this harness as an IDE agent wants
// the model to say what it is about to do ("Let me run list_dir to inspect…"),
// and that line legitimately repeats once per tool call. When narration is on
// the detector is deliberately blunt: it needs far more repetition, and it stops
// treating a short "Let me …" line as a tic at all — because that is exactly the
// narration pattern. With narration OFF the model is meant to emit only tool
// JSON, so repeated prose IS a loop and the sensitive thresholds apply.
//
// Config:
//   ANTI_SPIRAL=true|false   master switch (default false — opt in)
//   NARRATION=true|false     relaxes the detector (default false)
//   ANTI_SPIRAL_MIN_WORDS    don't judge text below this many words (default 40)

const MIN_WORDS = Number(process.env.ANTI_SPIRAL_MIN_WORDS) || 40;
// narrationOn is resolved per call so a running gateway picks up a config change.
const narrationOn = () => String(process.env.NARRATION || 'false').toLowerCase() === 'true';
const TAIL_WORDS = 150;
const TAIL_LINES = 12;

function stripNonProse(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, '\n')
        .replace(/~~~[\s\S]*?~~~/g, '\n')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/^\s*\|.*\|\s*$/gm, '\n')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?=\S)/gm, '')
        .replace(/^\s*[>#]+\s?/gm, '');
}

function isProseLine(line) {
    if (!line) return false;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 6) return false;
    const symbolish = (line.match(/[{}()[\];=<>|\\/_$@#*`~^]/g) || []).length;
    if (symbolish / line.length > 0.18) return false;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    return letters / line.length > 0.55;
}

function normalizeWords(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ')
        .split(/\s+/).filter(Boolean);
}

function sentencesOf(text) {
    return String(text || '').split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
}

function ngramCoverage(words, n) {
    if (words.length < n * 3) return { best: null, count: 0, coverage: 0 };
    const counts = new Map();
    let best = null;
    let bestCount = 0;
    for (let i = 0; i <= words.length - n; i++) {
        const g = words.slice(i, i + n).join(' ');
        const c = (counts.get(g) || 0) + 1;
        counts.set(g, c);
        if (c > bestCount) { bestCount = c; best = g; }
    }
    return { best, count: bestCount, coverage: (bestCount * n) / words.length };
}

function detectTic(lines, minCount) {
    const counts = new Map();
    let best = null;
    // Narration on: a "Let me …" line is the expected narration shape, so it
    // gets NO discount and the bar is raised — a normal session narrates every
    // tool call, and flagging that would break the IDE use case.
    const narr = narrationOn();
    if (narr) minCount = Math.max(minCount, 10);
    for (const raw of lines) {
        if (/:\s*$/.test(raw) || /^(user|assistant|system|old|new|before|after)\s*:/i.test(raw)) continue;
        if (raw.includes('  ')) continue;
        if (!/[.!?)]$/.test(raw)) continue;
        const key = raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ');
        const words = key.split(' ').filter(Boolean);
        if (words.length === 0 || words.length > 4) continue;
        if (words.some((w) => /\d/.test(w))) continue;
        const need = (!narr && key.startsWith('let me')) ? minCount : minCount + 2;
        const c = (counts.get(key) || 0) + 1;
        counts.set(key, c);
        if (c >= need && (!best || c > best.count)) best = { kind: 'tic', phrase: raw.trim().slice(0, 60), count: c };
    }
    return best;
}

function detectTailLoop(text) {
    if (!text) return null;
    const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
    const tic = detectTic(lines.slice(-40), narrationOn() ? 12 : 6);
    if (tic) return { ...tic, coverage: tic.count / Math.min(lines.length, 40) };
    if (lines.length >= TAIL_LINES) {
        const tail = lines.slice(-TAIL_LINES);
        const short = tail.every((l) => l.split(/\s+/).length <= 8);
        const distinct = new Set(tail.map((l) => l.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()));
        if (short && distinct.size <= 4) {
            const counts = new Map();
            for (const l of tail) counts.set(l, (counts.get(l) || 0) + 1);
            const [phrase, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
            return { kind: 'tail', phrase: phrase.slice(0, 140), count, coverage: count / tail.length };
        }
    }
    const words = normalizeWords(text);
    if (words.length < 60) return null;
    const tail = words.slice(-TAIL_WORDS);
    for (const n of [10, 9, 8, 7, 6, 5, 4, 3, 2]) {
        const { best, count, coverage } = ngramCoverage(tail, n);
        if (count >= 4 && coverage >= 0.6) return { kind: 'tail', phrase: best, count, coverage };
    }
    return null;
}

// Returns null when the text is not a loop, otherwise the evidence.
function detectSpiral(rawText) {
    if (!rawText) return null;
    const text = stripNonProse(rawText);
    const words = normalizeWords(text);
    if (words.length < MIN_WORDS) return null;

    const sentences = sentencesOf(text);
    for (let i = 1; i < sentences.length; i++) {
        const a = sentences[i - 1].toLowerCase().replace(/\s+/g, ' ').trim();
        const b = sentences[i].toLowerCase().replace(/\s+/g, ' ').trim();
        if (a.length > (narrationOn() ? 60 : 30) && a === b) {
            return { kind: 'sentence', phrase: sentences[i].slice(0, 140), count: 2 };
        }
    }

    const allLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const lines = allLines.filter(isProseLine).filter((l) => !/^["'\u201c]|:\s*["\u201c]/.test(l));
    const lineCounts = new Map();
    for (const l of lines) {
        const key = l.toLowerCase().replace(/\s+/g, ' ');
        const c = (lineCounts.get(key) || 0) + 1;
        lineCounts.set(key, c);
        if (c >= (narrationOn() ? 4 : 3)) return { kind: 'line', phrase: l.slice(0, 140), count: c };
    }

    const tic = detectTic(allLines, 4);
    if (tic) return { ...tic, coverage: tic.count / allLines.length };

    // 09-13: thresholds raised from the opencode plugin's (0.30/0.40/0.55).
    // Measured false positive: twelve DIFFERENT lines sharing a template
    // ("Step N: I inspected module N and applied the fix...") scored 0.38 on a
    // 5-gram because the fixed words repeat while the numbers change. That is
    // templated output, not a spiral. A real spiral repeats the SAME unit, so it
    // scores far higher — the "Let me run list_dir..." loop trips check 1 first
    // anyway. Digits are also excluded from the dominant n-gram for the same
    // reason: numbered lists vary by number.
    for (const n of [8, 7, 6, 5, 4, 3]) {
        const threshold = (n >= 5 ? 0.55 : n === 4 ? 0.60 : 0.70) + (narrationOn() ? 0.15 : 0);
        const { best, count, coverage } = ngramCoverage(words, n);
        if (count >= (narrationOn() ? 5 : 3) && coverage >= threshold && !/\d/.test(best || '')) {
            return { kind: 'phrase', phrase: best, count, coverage };
        }
    }

    return detectTailLoop(text);
}

function describe(evidence) {
    if (!evidence) return 'a repeated reasoning loop';
    const p = String(evidence.phrase || '').replace(/\s+/g, ' ').slice(0, 120);
    const n = evidence.count ? ` x${evidence.count}` : '';
    switch (evidence.kind) {
        case 'tic': return `the stall tic "${p}" repeated${n}`;
        case 'tail': return `the end of the message looping on "${p}"${n}`;
        case 'sentence': return `the same sentence twice in a row ("${p}")`;
        case 'line': return `the same line repeated${n} ("${p}")`;
        default: return `the phrase "${p}" dominating the message${n}`;
    }
}

// The banner is put at the TOP of the answer, per the owner's spec: the caller
// must see what happened before the model's text.
function spiralBanner(evidence) {
    return '🛑 [ANTI-SPIRAL] Generation stopped: ' + describe(evidence) +
        '. The loop was cut and the model was told to stop narrating and do the work. ' +
        'Partial work may be incomplete — re-send to continue.\n\n';
}

// The redirect sent back into the tab. Plain and short: webchat models follow a
// direct instruction far better than a diagnosis.
function spiralRedirect(evidence) {
    return 'STOP. You are stuck in a loop — ' + describe(evidence) + '. ' +
        'Do not repeat any sentence you have already written. Do not narrate what you are about to do. ' +
        'Reply with exactly ONE tool call JSON now, fenced as ```json ... ```, that makes real progress on the task ' +
        'you have not yet finished. If the task is genuinely complete, reply with the fenced submit_answer JSON instead. ' +
        'No prose outside the JSON.';
}

const enabled = () => String(process.env.ANTI_SPIRAL || 'false').toLowerCase() === 'true';

module.exports = { detectSpiral, describe, spiralBanner, spiralRedirect, enabled, stripNonProse };
