'use strict';
//
// ansi.js — a zero-dependency terminal UI toolkit.
//
// Why hand-rolled: this harness ships with four runtime deps and no build step,
// and its whole point is that a fresh clone runs. A TUI library would add a
// dependency tree and (for ink) a transpile step, to draw boxes and read arrow
// keys. Every primitive below is therefore plain ANSI.
//
// The interactive primitives (menu/multiSelect/prompt/confirm) all share one
// contract:
//   * they resolve a VALUE on Enter, or the sentinel `BACK` on Esc, or throw
//     `QUIT` if the user asks to quit. Callers handle all three.
//   * they always restore the cursor and cooked-mode stdin before resolving,
//     including on Ctrl-C, so a crash never leaves the user with an invisible
//     cursor and a dead shell.
//
// Pure formatting (pad/visibleWidth/wrap/boxLines/color) is separated from the
// input plumbing so it can be unit-tested without a TTY.

const ESC = '\u001b[';
const out = process.stdout;

// ── Sentinels ──────────────────────────────────────────────────────────────
const BACK = Symbol('back');   // Esc — go up one level
const QUIT = Symbol('quit');   // Ctrl-C / q at top level

class QuitError extends Error {
    constructor() { super('quit'); this.name = 'QuitError'; }
}

// ── Colour ─────────────────────────────────────────────────────────────────
// NO_COLOR is honoured (https://no-color.org), as is a non-TTY stdout, so piping
// the CLI into a file or a CI log produces clean text instead of escape codes.
const useColor = (() => {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return Boolean(out.isTTY);
})();

function sgr(code, s) {
    return useColor ? `${ESC}${code}m${s}${ESC}0m` : String(s);
}
const bold = (s) => sgr('1', s);
const dim = (s) => sgr('2', s);
const italic = (s) => sgr('3', s);
const underline = (s) => sgr('4', s);
const red = (s) => sgr('31', s);
const green = (s) => sgr('32', s);
const yellow = (s) => sgr('33', s);
const blue = (s) => sgr('34', s);
const magenta = (s) => sgr('35', s);
const cyan = (s) => sgr('36', s);
const gray = (s) => sgr('90', s);
const bgBlue = (s) => sgr('44', s);
const bgGray = (s) => sgr('100', s);

// ── Geometry ───────────────────────────────────────────────────────────────
function termWidth(fallback = 80) {
    const w = out.columns || Number(process.env.COLUMNS) || fallback;
    return Math.max(40, Math.min(140, w));
}
function termHeight(fallback = 24) {
    return Math.max(10, out.rows || Number(process.env.LINES) || fallback);
}

// Visible width: ANSI escapes and our own sentinels contribute nothing. Needed
// so padding maths is right when a string carries colour.
function visibleWidth(s) {
    // eslint-disable-next-line no-control-regex
    return String(s).replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(s, width, align = 'left') {
    const gap = Math.max(0, width - visibleWidth(s));
    if (align === 'right') return ' '.repeat(gap) + s;
    if (align === 'center') {
        const l = Math.floor(gap / 2);
        return ' '.repeat(l) + s + ' '.repeat(gap - l);
    }
    return s + ' '.repeat(gap);
}

function truncate(s, width) {
    const plain = String(s);
    if (visibleWidth(plain) <= width) return plain;
    if (width <= 1) return '…'.slice(0, width);
    // Cut on VISIBLE characters so a coloured string is not sliced mid-escape.
    let count = 0;
    // eslint-disable-next-line no-control-regex
    const tokens = plain.match(/\u001b\[[0-9;]*m|[\s\S]/g) || [];
    let built = '';
    for (const t of tokens) {
        if (t.startsWith('\u001b[')) { built += t; continue; }
        if (count >= width - 1) break;
        built += t;
        count += 1;
    }
    return built + '…' + (useColor ? `${ESC}0m` : '');
}

function wrap(text, width) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
        if (!line.length) { line = w; continue; }
        if (line.length + 1 + w.length <= width) line += ` ${w}`;
        else { lines.push(line); line = w; }
    }
    if (line.length) lines.push(line);
    return lines.length ? lines : [''];
}

// ── Boxes ──────────────────────────────────────────────────────────────────
// Pure: returns an array of lines, so callers can compose screens and tests can
// assert on the drawing without a terminal.
function boxLines(title, body, opts = {}) {
    const width = opts.width || termWidth();
    const inner = width - 4; // "│ " + content + " │"
    const lines = [];
    // The title must be truncated to fit, not just drawn: a title wider than the
    // box produced a ragged header line (measured 29 visible against a width of
    // 20) because the fill below clamps at zero but the title itself did not.
    // Budget: `┌` + `─` + titleText + fill + `┐` = width, so titleText must fit
    // in width - 3. titleText is " " + title + " ", hence the -5. Without this
    // the fill (which clamps at zero) left the header ragged — measured 22
    // visible against a width of 20.
    const titleText = title ? ` ${truncate(title, Math.max(0, width - 5))} ` : '';
    if (titleText) {
        const head = `┌─${bold(titleText)}`;
        const fill = '─'.repeat(Math.max(0, width - 2 - visibleWidth(`─${titleText}`)));
        lines.push(`${head}${fill}┐`);
    } else {
        lines.push(`┌${'─'.repeat(width - 2)}┐`);
    }
    for (const item of body) {
        if (item === '' || item === null || item === undefined) {
            lines.push(`│${' '.repeat(width - 2)}│`);
            continue;
        }
        const text = typeof item === 'string' ? item : item.text;
        const align = (typeof item === 'object' && item.align) || 'left';
        for (const [i, seg] of wrap(text, inner).entries()) {
            lines.push(`│ ${pad(seg, inner, i === 0 ? align : 'left')} │`);
        }
    }
    lines.push(`└${'─'.repeat(width - 2)}┘`);
    return lines;
}

// ── Screen control ─────────────────────────────────────────────────────────
// Gated on a real TTY. Writing a clear-screen escape into a pipe or a CI log
// leaves literal `[2J[H` in the output — visible in `webchat --help | less` and
// in any captured log — because nothing interprets it.
const isTty = Boolean(out.isTTY);
function clear() { if (isTty) out.write(`${ESC}2J${ESC}H`); }
function home() { if (isTty) out.write(`${ESC}H`); }
function hideCursor() { if (isTty) out.write(`${ESC}?25l`); }
function showCursor() { if (isTty) out.write(`${ESC}?25h`); }
function write(s) { out.write(s); }
function line(s = '') { out.write(`${s}\n`); }
function newline(n = 1) { out.write('\n'.repeat(n)); }

let restored = false;
function restore() {
    if (restored) return;
    restored = true;
    showCursor();
    if (process.stdin.isTTY && process.stdin.isRaw) {
        try { process.stdin.setRawMode(false); } catch { /* already cooked */ }
    }
    process.stdin.pause();
}
function installGuards() {
    process.on('exit', restore);
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { restore(); process.exit(sig === 'SIGINT' ? 130 : 143); });
    }
}

// ── Input plumbing ─────────────────────────────────────────────────────────
// Retained for callers that only ever want a single unambiguous chunk
// (CLI-authored input, tests). readKey() does its own buffering instead — see
// the ESC-ambiguity note above it.
function withRaw(fn) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        const onData = (buf) => { cleanup(); fn(buf); };
        function cleanup() {
            stdin.removeListener('data', onData);
            if (stdin.isTTY && !wasRaw) { try { stdin.setRawMode(false); } catch { /* noop */ } }
        }
        try {
            if (stdin.isTTY) stdin.setRawMode(true);
            stdin.resume();
            stdin.on('data', onData);
        } catch (e) {
            cleanup();
            reject(e);
        }
    });
}

// One keypress → a readable name. Decodes the escape sequences arrow keys emit.
//
// ESC is AMBIGUOUS: it is both the "go back" key and the first byte of every
// arrow sequence. A terminal normally delivers `\u001b[A` in one chunk, but not
// always — over SSH/mosh, through `script`, or when the process is slow to read,
// the three bytes arrive as three separate reads and a naive parser sees a lone
// ESC and navigates BACK instead of moving the cursor. Measured in the smoke
// test: the Gates screen was unreachable because every arrow-down was read as a
// cancel.
//
// So a chunk that is EXACTLY ESC is held for a moment to see whether the rest of
// a sequence follows. A real ESC keypress then costs `escSequenceMs` before it
// registers, which is the standard trade every terminal UI makes.
const ESC_SEQUENCE_MS = 60;

function decodeChunk(s) {
    if (s === '\u0003') return { name: 'ctrl-c' };
    if (s === '\r' || s === '\n') return { name: 'enter' };
    if (s === '\u007f' || s === '\b') return { name: 'backspace' };
    if (s === '\u001b') return { name: 'escape' };
    if (s === ' ') return { name: 'space' };
    if (s === '\t') return { name: 'tab' };
    const seq = {
        '\u001b[A': 'up', '\u001b[B': 'down', '\u001b[C': 'right', '\u001b[D': 'left',
        '\u001b[5~': 'pageup', '\u001b[6~': 'pagedown', '\u001b[H': 'home', '\u001b[F': 'end',
        '\u001bOA': 'up', '\u001bOB': 'down', '\u001bOC': 'right', '\u001bOD': 'left',
        '\u001b[1~': 'home', '\u001b[4~': 'end',
    };
    if (seq[s]) return { name: seq[s] };
    if (s.length === 1) return { name: 'char', char: s };
    return { name: 'unknown', raw: s };
}

function readKey() {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        let buffer = '';
        let settle = null;

        function cleanup() {
            if (settle) { clearTimeout(settle); settle = null; }
            stdin.removeListener('data', onData);
            if (stdin.isTTY && !wasRaw) { try { stdin.setRawMode(false); } catch { /* noop */ } }
        }
        function finish(seq) {
            cleanup();
            resolve(decodeChunk(seq));
        }
        function onData(buf) {
            buffer += buf.toString('utf8');
            // A lone ESC is held briefly in case the rest of a sequence is behind
            // it. Anything longer is unambiguous and resolves immediately.
            if (buffer === '\u001b') {
                if (settle) clearTimeout(settle);
                settle = setTimeout(() => finish(buffer), ESC_SEQUENCE_MS);
                return;
            }
            if (settle) { clearTimeout(settle); settle = null; }
            finish(buffer);
        }
        try {
            if (stdin.isTTY) stdin.setRawMode(true);
            stdin.resume();
            stdin.on('data', onData);
        } catch (e) {
            cleanup();
            resolve({ name: 'unknown', raw: String(e && e.message) });
        }
    });
}

// ── Interactive primitives ─────────────────────────────────────────────────

// Arrow-key menu. `items` = [{label, hint, value, disabled}]; returns the chosen
// item's value, or BACK on Esc, or throws QuitError on Ctrl-C.
async function menu(items, opts = {}) {
    const { title, footer, width = termWidth(), pageSize } = opts;
    let index = Math.max(0, items.findIndex((i) => !i.disabled));
    const size = pageSize || Math.max(3, Math.min(items.length, termHeight() - 10));

    for (;;) {
        const start = Math.max(0, Math.min(index - Math.floor(size / 2), Math.max(0, items.length - size)));
        const view = items.slice(start, start + size);
        const rendered = view.map((item, i) => {
            const abs = start + i;
            const active = abs === index;
            const pointer = active ? cyan('❯') : ' ';
            const label = item.disabled
                ? gray(truncate(item.label, width - 8))
                : (active ? bold(item.label) : item.label);
            const hint = item.hint ? gray(`  ${truncate(item.hint, Math.max(0, width - visibleWidth(item.label) - 12))}`) : '';
            return `${pointer} ${label}${hint}`;
        });
        const body = [];
        if (title) body.push(bold(title), '');
        body.push(...rendered);
        if (items.length > size) {
            body.push('');
            body.push(gray(`  ${index + 1}/${items.length}`));
        }
        clear();
        for (const l of boxLines(title ? '' : '', body, { width })) line(l);
        if (footer) { newline(); for (const f of [].concat(footer)) line(gray(`  ${f}`)); }
        hideCursor();

        const key = await readKey();
        if (key.name === 'ctrl-c') { showCursor(); throw new QuitError(); }
        if (key.name === 'escape') { showCursor(); return BACK; }
        if (key.name === 'up') index = (index - 1 + items.length) % items.length;
        else if (key.name === 'down') index = (index + 1) % items.length;
        else if (key.name === 'pageup') index = Math.max(0, index - size);
        else if (key.name === 'pagedown') index = Math.min(items.length - 1, index + size);
        else if (key.name === 'home') index = 0;
        else if (key.name === 'end') index = items.length - 1;
        else if (key.name === 'enter' || key.name === 'space' || key.name === 'char') {
            const item = items[index];
            if (item && !item.disabled) { showCursor(); return item.value !== undefined ? item.value : item; }
        }
    }
}

// Checkbox list. Space toggles, Enter confirms. `items` = [{label, hint, on}].
// Returns an array of booleans aligned to `items`.
async function multiSelect(items, opts = {}) {
    const { title, footer, width = termWidth() } = opts;
    const state = items.map((i) => Boolean(i.on));
    let index = 0;
    const size = Math.max(3, Math.min(items.length, termHeight() - 10));

    for (;;) {
        const start = Math.max(0, Math.min(index - Math.floor(size / 2), Math.max(0, items.length - size)));
        const view = items.slice(start, start + size);
        const rendered = view.map((item, i) => {
            const abs = start + i;
            const active = abs === index;
            const tick = state[abs] ? green('◉') : gray('◯');
            const pointer = active ? cyan('❯') : ' ';
            const label = active ? bold(item.label) : item.label;
            const hint = item.hint ? gray(`  ${truncate(item.hint, Math.max(0, width - visibleWidth(item.label) - 12))}`) : '';
            return `${pointer} ${tick} ${label}${hint}`;
        });
        const body = [];
        if (title) body.push(bold(title), '');
        body.push(...rendered);
        clear();
        for (const l of boxLines('', body, { width })) line(l);
        newline();
        line(gray('  space toggle · enter save · esc cancel'));
        if (footer) line(gray(`  ${footer}`));
        hideCursor();

        const key = await readKey();
        if (key.name === 'ctrl-c') { showCursor(); throw new QuitError(); }
        if (key.name === 'escape') { showCursor(); return BACK; }
        if (key.name === 'up') index = (index - 1 + items.length) % items.length;
        else if (key.name === 'down') index = (index + 1) % items.length;
        else if (key.name === 'space' || (key.name === 'char' && key.char === 'x')) state[index] = !state[index];
        else if (key.name === 'enter') { showCursor(); return state; }
    }
}

// Text input. `validate(value)` returns an error string or null.
async function prompt(label, opts = {}) {
    const { default: dflt = '', mask = false, hint, width = termWidth(), validate } = opts;
    let value = '';
    let error = '';

    for (;;) {
        const shown = mask ? '*'.repeat(value.length) : value;
        const body = [];
        body.push(`${bold(label)}`);
        if (hint) body.push(gray(hint));
        body.push('');
        body.push(`  ${shown}${cyan('▏')}`);
        if (error) body.push('', red(`  ${error}`));
        clear();
        for (const l of boxLines('', body, { width })) line(l);
        newline();
        line(gray(`  enter accept${dflt !== '' ? ' (blank = ' + (mask ? '(unchanged)' : dflt) + ')' : ''} · esc cancel`));
        showCursor();

        const key = await readKey();
        if (key.name === 'ctrl-c') throw new QuitError();
        if (key.name === 'escape') return BACK;
        if (key.name === 'enter') {
            const final = value === '' ? dflt : value;
            if (validate) {
                const err = validate(final);
                if (err) { error = err; continue; }
            }
            return final;
        }
        if (key.name === 'backspace') { value = value.slice(0, -1); error = ''; continue; }
        if (key.name === 'char') { value += key.char; error = ''; continue; }
        if (key.name === 'space') { value += ' '; error = ''; }
    }
}

async function confirm(label, opts = {}) {
    const answer = await menu([
        { label: 'Yes', value: true },
        { label: 'No', value: false },
    ], { title: label, footer: opts.footer, width: opts.width });
    return answer;
}

// A non-interactive message screen. Any key continues.
async function message(title, body, opts = {}) {
    clear();
    for (const l of boxLines(title, [].concat(body), { width: opts.width || termWidth() })) line(l);
    newline();
    line(gray(`  ${opts.footer || 'press any key to continue'}`));
    hideCursor();
    await readKey();
    showCursor();
}

module.exports = {
    ESC, BACK, QUIT, QuitError,
    bold, dim, italic, underline, red, green, yellow, blue, magenta, cyan, gray, bgBlue, bgGray,
    useColor,
    termWidth, termHeight, visibleWidth, pad, truncate, wrap, boxLines,
    clear, home, hideCursor, showCursor, write, line, newline, restore, installGuards,
    readKey, menu, multiSelect, prompt, confirm, message,
};
