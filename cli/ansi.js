'use strict';

// One-shot guard so a repeatedly-failing menu tick warns instead of flooding stderr.
let ansiWarnedTick = false;
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
// ── Sizing ─────────────────────────────────────────────────────────────────
//
// The UI takes the WHOLE terminal by default. It used to clamp at 140 columns,
// which on a wide monitor left a narrow strip of box floating in empty space.
//
// Both bounds are settings read from the same place as everything else, and the
// defaults are "use what you have". The small default margin exists because a
// 300-column line is genuinely hard to read — it is a setting, not a cap.
function uiOpts() {
    const m = Number(process.env.WEBCHAT_UI_MARGIN);
    return {
        margin: Number.isFinite(m) && m >= 0 ? m : 2,
        maxWidth: Number(process.env.WEBCHAT_UI_MAX_WIDTH) || 0,
    };
}

// ── The terminal's real size ───────────────────────────────────────────────
//
// This used to be `stdout.columns || COLUMNS || 80` and nothing else, which is
// wrong in the one case that matters: when stdout is NOT a TTY — a wrapper, a
// pipe, `tee`, a multiplexer that does not export COLUMNS — both of those are
// undefined and the whole dashboard was drawn into an 80x24 box. On a large
// terminal that is a small strip floating in space, which is exactly the
// "the CLI is tiny" report.
//
// So: ask the live TTY, then the environment, then the CONTROLLING terminal via
// /dev/tty (which survives a redirected stdout), then the terminfo default. The
// answer is cached briefly so a redraw is not a fork per frame, and invalidated
// on resize.
let _externalSize = { at: 0, columns: 0, rows: 0 };
const EXTERNAL_TTL_MS = 1000;

// Only the EXPENSIVE probe is cached — the cheap sources (the live stream, the env)
// are re-read on every call, because those are what change when a test or a
// multiplexer moves the goalposts, and a stale width draws a ragged frame.
function _externalTtySize() {
    if (_externalSize.columns > 0 && (Date.now() - _externalSize.at) < EXTERNAL_TTL_MS) return _externalSize;
    let columns = 0;
    let rows = 0;

    // `stty size < /dev/tty` reports the CONTROLLING terminal even when stdout is
    // piped — the case that produced the tiny box. Output is "<rows> <columns>".
    try {
        const { execFileSync } = require('child_process');
        const raw = execFileSync('sh', ['-c', 'stty size < /dev/tty 2>/dev/null'], {
            timeout: 400,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
        });
        const [r, c] = String(raw).trim().split(/\s+/).map(Number);
        if (r > 0) rows = r;
        if (c > 0) columns = c;
    } catch (_) { /* no controlling tty — fall through */ }

    // `tput` reads terminfo, so it works with no tty at all when TERM is set.
    if (!columns || !rows) {
        try {
            const { execFileSync } = require('child_process');
            const c = Number(execFileSync('tput', ['cols'], { timeout: 400, encoding: 'utf8' }).trim());
            const r = Number(execFileSync('tput', ['lines'], { timeout: 400, encoding: 'utf8' }).trim());
            if (!columns && c > 0) columns = c;
            if (!rows && r > 0) rows = r;
        } catch (_) { /* no terminfo either */ }
    }

    _externalSize = { at: Date.now(), columns, rows };
    return _externalSize;
}

// Each dimension is resolved INDEPENDENTLY. Requiring both from one source throws
// away a width you do have (`stdout.columns` set, `rows` undefined — the normal
// shape outside a tty) and falls all the way back to 80 columns.
function termSize() {
    let columns = Number(out.columns) || 0;
    let rows = Number(out.rows) || 0;
    if (!columns) columns = Number(process.env.COLUMNS) || 0;
    if (!rows) rows = Number(process.env.LINES) || 0;
    if (!columns || !rows) {
        const ext = _externalTtySize();
        if (!columns) columns = ext.columns;
        if (!rows) rows = ext.rows;
    }
    return { columns: columns || 80, rows: rows || 24 };
}

// A resize must land immediately, not on the next cache expiry.
function _forgetSize() { _externalSize = { at: 0, columns: 0, rows: 0 }; }
if (typeof out.on === 'function') out.on('resize', _forgetSize);
if (typeof process.on === 'function') process.on('SIGWINCH', _forgetSize);

function termWidth(fallback = 80) {
    const { columns } = termSize();
    const w = columns || fallback;
    const { margin, maxWidth } = uiOpts();
    const usable = Math.max(40, w - margin * 2);
    return maxWidth > 0 ? Math.min(maxWidth, usable) : usable;
}
function termHeight(fallback = 24) {
    return Math.max(10, termSize().rows || fallback);
}
// How many body rows fit, so a screen fills the terminal instead of stopping a
// third of the way down.
function bodyRows(reserved = 6) {
    return Math.max(6, termHeight() - reserved);
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
      const s = String(text);
      // Measure VISIBLE width, and keep the original spacing.
      //
      // Both halves are load-bearing. These strings carry ANSI colour codes, and the
      // old version compared raw `String.length`, so every escape byte counted as a
      // character: a bold menu label measured 26 instead of 17 and the line wrapped
      // two words early (measured on the live dashboard — the hint broke onto its own
      // line inside an 80-column box that had room for all of it). The old version
      // also collapsed runs of whitespace by splitting on /\s+/ and rejoining with a
      // single space, which silently ate the deliberate two-space gap before a hint.
      const parts = s.match(/\S+\s*/g);
      if (!parts) return [''];
      const lines = [];
      let line = '';
      for (const part of parts) {
          const word = part.replace(/\s+$/, '');
          const trailing = part.slice(word.length);
          const joined = line ? line + part : part;
          // Trailing whitespace never counts, or a line ending exactly on the boundary
          // would wrap purely because of the space after its last word.
          const measure = joined.replace(/\s+$/, '');
          if (line && visibleWidth(measure) > width) {
              lines.push(line.replace(/\s+$/, ''));
              line = word + trailing;
          } else {
              line = joined;
          }
      }
      const last = line.replace(/\s+$/, '');
      if (last || !lines.length) lines.push(last);
      return lines.length ? lines : [''];
  }

// ── Boxes ──────────────────────────────────────────────────────────────────
// Pure: returns an array of lines, so callers can compose screens and tests can
// assert on the drawing without a terminal.
// Drop a block into the middle of the terminal instead of leaving it stranded at the
// top. A tall window with the UI pinned to its first six rows reads as "the program is
// tiny"; centring it uses the screen the user actually has.
// Pad to a column by VISIBLE width. `String.padEnd` counts ANSI escapes as characters,
// so a bold line - which carries colour codes - ends up shorter than the plain lines
// beside it and the whole block shifts sideways on exactly the line that matters most.
function padVisible(text, width) {
    const s = String(text == null ? '' : text);
    const gap = width - visibleWidth(s);
    return gap > 0 ? s + ' '.repeat(gap) : s;
}

// Wrap prose to a column. Used so text and the character can share a row without the
// text pushing him off to the right on its longest line - the block has to be a fixed
// width or the alignment slips on exactly the lines that carry the most.
function wrapText(text, width) {
    const out = [];
    for (const para of String(text == null ? '' : text).split('\n')) {
