'use strict';
//
// stickman.js — a little ASCII character who waves, points, and talks.
//
// Pure text on purpose: no box-drawing tricks that break on a font we cannot see, no
// Unicode the user's terminal might not have. Every frame is plain ASCII, and every
// frame has the SAME number of lines and the same width, so swapping one for the next
// animates in place instead of jittering down the screen.
//
// The head is a smiley face, which is also how you can tell at a glance which frame is
// which while debugging: if the face is missing, a frame is malformed.

// ── the character ───────────────────────────────────────────────────────────
//
// Five lines each, one expression, arm moving through a wave. Widths are padded to the
// widest line so the block sits still while the arm moves.

// A body with a chosen arm position. Building every pose from ONE body is what keeps
// them interchangeable: arms change, nothing else moves, so the animation reads as a
// wave rather than as the character jumping about.
const body = (arm) => [
    '      .-------.  ',
    '     /  ^   ^  \\ ',
    '    |    ___    |',
    '     \\  \\___/  / ',
    "      '-------'  ",
    arm,
    '        | |      ',
    '       /   \\     ',
    '      /     \\    ',
];

// The arm rises through these, so cycling them is a wave.
const WAVE = [
    body('       /| |\\     '),   // down
    body('       /| | \\    '),
    body('       /| |  \\   '),
    body('       /| |   \\  '),   // up
    body('       /| |  \\   '),
    body('       /| | \\    '),
];

const IDLE = body('       /| |\\     ');
const POINT = body('       /| |----> ');
const THINK = [
    '      .-------.  ',
    '     /  o   o  \\ ',
    '    |     _     |',
    '     \\   ---   / ',
    "      '-------'  ",
    '     ? /| |\\     ',
    '        | |      ',
    '       /   \\     ',
    '      /     \\    ',
];
const CHEER = body('      \\| |/      ');

const POSES = { idle: IDLE, wave: WAVE, point: POINT, think: THINK, cheer: CHEER };

// Map a pose name to a function that returns the frame for a tick. `wave` cycles; every
// other pose is still, so a caller can use one call site for all of them.
function frameFor(pose, tick) {
    const set = POSES[pose] || IDLE;
    if (Array.isArray(set[0])) return set[tick % set.length];
    return set;
}

// ── drawing ─────────────────────────────────────────────────────────────────

// The character beside some lines of text. The text is what a person reads, so it keeps
// the left edge and the character sits to its right; a bubble with nothing in it is
// simply not drawn.
function beside(lines, pose = 'idle', tick = 0, opts = {}) {
    const art = frameFor(pose, tick).map((l) => String(l).padEnd(11));
    const text = (lines || []).map(String);
    // The text column is a fixed width so the character sits in the SAME column on every
    // row. Padding only the art (which is what this did first) walked him in and out as
    // the lines changed length - it read as a rendering bug.
    const col = opts.column || Math.max(0, ...text.map((l) => l.length));
    const rows = Math.max(art.length, text.length);
    const out = [];
    for (let i = 0; i < rows; i++) {
        const a = art[i] || '           ';
        const t = text[i] || '';
        out.push(t ? `${t.padEnd(col)}   ${a}`.trimEnd() : (a.trim() ? `${''.padEnd(col)}   ${a}`.trimEnd() : ''));
    }
    return out;
}

// The character ABOVE the text, centred on him, for a greeting where there is no room
// to sit side by side.
function above(lines, pose = 'idle', tick = 0) {
    const art = frameFor(pose, tick);
    return art.concat('', (lines || []));
}

// ── animation ───────────────────────────────────────────────────────────────
//
// Redraw the SAME rows in place. `A.clear()` takes the whole screen, which is right for
// a full screen and wrong mid-paragraph, so this moves the cursor back up over the block
// it last drew instead.
function makeAnimator(A, getFrame, opts = {}) {
    const lines = opts.lines || 5;
    let drawn = 0;
    return {
        // Draw one frame over the previous one.
        step(tick) {
            if (drawn) A.write(`\x1b[${drawn}A`);       // back to the top of the block
            const frame = getFrame(tick);
            for (let i = 0; i < lines; i++) {
                A.write('\x1b[2K');                      // clear the whole line first, or a
                A.write(`${frame[i] || ''}\n`);          // shorter frame leaves debris
            }
            drawn = lines;
        },
        done() { drawn = 0; },
    };
}

// Wave for a moment, then hand the screen back. Blocking on purpose: this runs once, at
// the start, before there is anything else to do, and a greeting that races the text
// after it looks broken.
async function waveFor(A, ms = 1400, intervalMs = 190) {
    const anim = makeAnimator(A, (t) => frameFor('wave', t), { lines: 5 });
    const steps = Math.max(1, Math.round(ms / intervalMs));
    for (let i = 0; i < steps; i++) {
        anim.step(i);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    anim.done();
}

// The character beside a block of text, centred against it. `beside` puts him at the TOP,
// which looks wrong the moment the text is longer than he is: he ends up standing next to
// the greeting and nothing else, and the rest of the paragraph runs on without him.
function besideCentred(lines, pose = 'idle', tick = 0, opts = {}) {
    const art = frameFor(pose, tick);
    const text = (lines || []).map(String);
    const col = opts.column || Math.max(0, ...text.map((l) => l.length));
    const offset = Math.max(0, Math.floor((text.length - art.length) / 2));
    const rows = [];
    for (let i = 0; i < text.length; i++) {
        const a = art[i - offset];
        const s = text[i];
        if (!a) { rows.push(s ? { text: s } : null); continue; }
        rows.push({ text: s, art: a });
    }
    // Callers that want plain strings get them; the CLI pads by visible width itself, so
    // the two columns stay aligned even when one side is coloured.
    return rows.map((r) => (r === null ? null : { s: r.text, a: r.art || '' }));
}

module.exports = {
    WAVE, IDLE, POINT, THINK, CHEER,
    frameFor, beside, besideCentred, above, makeAnimator, waveFor,
};
