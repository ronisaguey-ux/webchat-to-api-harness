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

function sgr(code: string, s: unknown): string {
    return useColor ? `${ESC}${code}m${s}${ESC}0m` : String(s);
}
const bold = (s: unknown): string => sgr('1', s);
const dim = (s: unknown): string => sgr('2', s);
const italic = (s: unknown): string => sgr('3', s);
const underline = (s: unknown): string => sgr('4', s);
const red = (s: unknown): string => sgr('31', s);
const green = (s: unknown): string => sgr('32', s);
const yellow = (s: unknown): string => sgr('33', s);
const blue = (s: unknown): string => sgr('34', s);
const magenta = (s: unknown): string => sgr('35', s);
const cyan = (s: unknown): string => sgr('36', s);
const gray = (s: unknown): string => sgr('90', s);
const bgBlue = (s: unknown): string => sgr('44', s);
const bgGray = (s: unknown): string => sgr('100', s);

// ── Geometry ───────────────────────────────────────────────────────────────
// ── Sizing ─────────────────────────────────────────────────────────────────
//
// The UI takes the WHOLE terminal by default. It used to clamp at 140 columns,
// which on a wide monitor left a narrow strip of box floating in empty space.
//
// Both bounds are settings read from the same place as everything else, and the
// defaults are "use what you have". The small default margin exists because a
// 300-column line is genuinely hard to read — it is a setting, not a cap.
export interface UiOptions {
    margin: number;
    maxWidth: number;
}

export interface BlockOptions {
    center?: boolean;
    reserve?: number;
    width?: number;
}

export interface BoxBodyItem {
    text?: string;
    align?: string;
}

export interface MenuOptions {
    title?: string;
    footer?: string | string[];
    width?: number;
    pageSize?: number;
    tickMs?: number;
    onTick?: (() => string[] | void) | null;
    startIndex?: number;
    above?: string[] | (() => string[]);
}

export interface SelectItem {
    label: string;
    hint?: string;
    value?: unknown;
    disabled?: boolean;
    on?: boolean;
}

export interface PromptOptions {
    default?: string;
    mask?: boolean;
    hint?: string;
    width?: number;
    validate?: (value: string) => string | null | undefined;
}

export interface MenuItem {
    label?: string;
    value?: unknown;
    key?: string;
    hint?: string;
    [key: string]: unknown;
}

function uiOpts(): UiOptions {
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
let _externalSize: { at: number; columns: number; rows: number } = { at: 0, columns: 0, rows: 0 };
const EXTERNAL_TTL_MS = 1000;

// Only the EXPENSIVE probe is cached — the cheap sources (the live stream, the env)
// are re-read on every call, because those are what change when a test or a
// multiplexer moves the goalposts, and a stale width draws a ragged frame.
function _externalTtySize(): { at: number; columns: number; rows: number } {
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
function termSize(): { at: number; columns: number; rows: number } {
    let columns = Number(out.columns) || 0;
    let rows = Number(out.rows) || 0;
    if (!columns) columns = Number(process.env.COLUMNS) || 0;
    if (!rows) rows = Number(process.env.LINES) || 0;
    if (!columns || !rows) {
        const ext = _externalTtySize();
        if (!columns) columns = ext.columns;
        if (!rows) rows = ext.rows;
    }
    return { at: Date.now(), columns: columns || 80, rows: rows || 24 };
}

// A resize must land immediately, not on the next cache expiry.
function _forgetSize(): void { _externalSize = { at: 0, columns: 0, rows: 0 }; }
if (typeof out.on === 'function') out.on('resize', _forgetSize);
if (typeof process.on === 'function') process.on('SIGWINCH', _forgetSize);

function termWidth(fallback: number = 80): number {
    const { columns } = termSize();
    const w = columns || fallback;
    const { margin, maxWidth } = uiOpts();
    const usable = Math.max(40, w - margin * 2);
    return maxWidth > 0 ? Math.min(maxWidth, usable) : usable;
}
function termHeight(fallback: number = 24): number {
    return Math.max(10, termSize().rows || fallback);
}
// How many body rows fit, so a screen fills the terminal instead of stopping a
// third of the way down.
function bodyRows(reserved: number = 6): number {
    return Math.max(6, termHeight() - reserved);
}

// Visible width: ANSI escapes and our own sentinels contribute nothing. Needed
// so padding maths is right when a string carries colour.
function visibleWidth(s: unknown): number {
    // eslint-disable-next-line no-control-regex
    return String(s).replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(s: string, width: number, align: string = 'left'): string {
    const gap = Math.max(0, width - visibleWidth(s));
    if (align === 'right') return ' '.repeat(gap) + s;
    if (align === 'center') {
        const l = Math.floor(gap / 2);
        return ' '.repeat(l) + s + ' '.repeat(gap - l);
    }
    return s + ' '.repeat(gap);
}

function truncate(s: unknown, width: number): string {
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

  function wrap(text: unknown, width: number): string[] {
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
      const lines: string[] = [];
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
function padVisible(text: unknown, width: number): string {
    const s = String(text == null ? '' : text);
    const gap = width - visibleWidth(s);
    return gap > 0 ? s + ' '.repeat(gap) : s;
}

// Wrap prose to a column. Used so text and the character can share a row without the
// text pushing him off to the right on its longest line - the block has to be a fixed
// width or the alignment slips on exactly the lines that carry the most.
function wrapText(text: unknown, width: number): string[] {
    const out: string[] = [];
    for (const para of String(text == null ? '' : text).split('\n')) {
        if (!para.trim()) { out.push(''); continue; }
        let line = '';
        for (const word of para.split(/\s+/)) {
            if (!line) { line = word; continue; }
            if (line.length + 1 + word.length <= width) line += ` ${word}`;
            else { out.push(line); line = word; }
        }
        if (line) out.push(line);
    }
    return out;
}

function centerBlock(lines: string[] | null | undefined, opts: BlockOptions = {}): string[] {
    const list = (lines || []).map(String);
    if (opts.center === false) return list;
    const rows = termHeight();
    const used = list.length + (opts.reserve || 0);
    const pad = Math.max(0, Math.floor((rows - used) / 2));
    return new Array(pad).fill('').concat(list);
}

function boxLines(title: unknown, body: Array<string | BoxBodyItem | null | undefined>, opts: BlockOptions = {}): string[] {
    const width = opts.width || termWidth();
    const inner = width - 4; // "│ " + content + " │"
    const lines: string[] = [];
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
function clear(): void { if (isTty) out.write(`${ESC}2J${ESC}H`); }
function home(): void { if (isTty) out.write(`${ESC}H`); }
function hideCursor(): void { if (isTty) out.write(`${ESC}?25l`); }
function showCursor(): void { if (isTty) out.write(`${ESC}?25h`); }
function write(s: string): void { out.write(s); }
function line(s: string = ''): void { out.write(`${s}\n`); }
function newline(n: number = 1): void { out.write('\n'.repeat(n)); }

let restored = false;
function restore() {
    if (restored) return;
    restored = true;
    exitFullScreen();
    showCursor();
    if (process.stdin.isTTY && process.stdin.isRaw) {
        try { process.stdin.setRawMode(false); } catch { /* already cooked */ }
    }
    process.stdin.pause();
}

// ── Full-screen mode (the alternate screen buffer) ─────────────────────────
// Without this the UI is drawn INLINE into the terminal's scrollback: the frame
// scrolls up with every redraw and the previous screen stays behind it, so a
// paginated view reads as a small box sitting in the middle of old output rather
// than as a full-screen app. `CSI ?1049h` switches to the alternate buffer, which
// is the mechanism every full-screen TUI (vim, less, htop) uses — the terminal
// gives the app the whole viewport and restores the user's scrollback intact on
// exit. That is what "take up the full screen" means, and no amount of width or
// height maths achieves it.
//
// Guarded on isTty so a pipe, a test or a log capture is unchanged, and paired
// with exitFullScreen() in restore() so every exit path — Quit, Ctrl-C, a thrown
// error, process exit — hands the terminal back.
let _fullScreen = false;
function enterFullScreen() {
    if (!isTty || _fullScreen) return;
    _fullScreen = true;
    out.write(`${ESC}?1049h`);
    out.write(`${ESC}2J${ESC}H`);
}
function exitFullScreen() {
    if (!_fullScreen) return;
    _fullScreen = false;
    if (!isTty) return;
    out.write(`${ESC}?1049l`);
}
function isFullScreen() { return _fullScreen; }

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
function withRaw(fn: (chunk: string) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        const onData = (buf: string): void => { cleanup(); fn(buf); };
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

const KEY_SEQUENCES = {
    '\u001b[A': 'up', '\u001b[B': 'down', '\u001b[C': 'right', '\u001b[D': 'left',
    '\u001b[5~': 'pageup', '\u001b[6~': 'pagedown', '\u001b[H': 'home', '\u001b[F': 'end',
    '\u001bOA': 'up', '\u001bOB': 'down', '\u001bOC': 'right', '\u001bOD': 'left',
    '\u001b[1~': 'home', '\u001b[4~': 'end',
};

// Longest first, so `\u001b[5~` is matched as page-up rather than as a lone ESC
// followed by garbage. Two sequences share prefixes (`\u001b[A` and `\u001bOA` do not,
// but `\u001b[H` and `\u001b[1~` both start `\u001b[`), and the longest match wins.
const SEQUENCES_BY_LENGTH = Object.keys(KEY_SEQUENCES).sort((a, b) => b.length - a.length);

/**
 * Split ONE stdin read into the keys it actually contains.
 *
 * A terminal is free to deliver several keystrokes in a single read — a paste, a fast
 * typist, or an arrow key and an Enter arriving together. Resolving a chunk as one key
 * throws the rest away, which reads as dropped input: press down-down-Enter quickly
 * and only the first registers. Measured while testing: a piped file of arrow keys
 * produced a "passing" smoke run in which no key after the first had any effect.
 */
function splitKeys(s: string): string[] {
    const keys: string[] = [];
    let i = 0;
    while (i < s.length) {
        if (s[i] === '\u001b') {
            const hit = SEQUENCES_BY_LENGTH.find((seq) => s.startsWith(seq, i));
            if (hit) { keys.push(hit); i += hit.length; continue; }
            keys.push('\u001b'); i += 1; continue;
        }
        // Iterate by CODE POINT, not by index: an emoji or accented character is one
        // key to the user but two UTF-16 units to a naive slice.
        const cp = s.codePointAt(i) as number;
        const ch = String.fromCodePoint(cp);
        keys.push(ch);
        i += ch.length;
    }
    return keys;
}

export interface DecodedKey {
    name: string;
    char?: string;
    raw?: string;
}

function decodeChunk(s: string): DecodedKey {
    if (s === '\u0003') return { name: 'ctrl-c' };
    if (s === '\r' || s === '\n') return { name: 'enter' };
    if (s === '\u007f' || s === '\b') return { name: 'backspace' };
    if (s === '\u001b') return { name: 'escape' };
    if (s === ' ') return { name: 'space' };
    if (s === '\t') return { name: 'tab' };
    if ((KEY_SEQUENCES as Record<string, string>)[s]) return { name: (KEY_SEQUENCES as Record<string, string>)[s] };
    if (s.length === 1) return { name: 'char', char: s };
    return { name: 'unknown', raw: s };
}

// Keys read in one chunk but not yet consumed. A paste or a fast double-tap must not
// lose the tail, so the remainder is held here and handed out by later readKey calls.
const PENDING_KEYS: string[] = [];

  function readKey(opts: { tickMs?: number } = {}): Promise<DecodedKey> {
      // `tickMs` lets a caller redraw on a timer while still waiting for a key.
      // It MUST live inside this function rather than being raced outside it: a
      // raced readKey leaves its stdin `data` listener registered, so the next call
      // stacks a second listener and one keypress resolves two promises.
      const tickMs = Number(opts.tickMs) || 0;

      // Anything buffered from an earlier read is delivered first, without touching
      // stdin — otherwise a key that already arrived waits for the next one. It must
      // go through decodeChunk like any other key: handing back the raw bytes gives
      // the caller an object with no `name` and the keypress is silently ignored.
      if (PENDING_KEYS.length) return Promise.resolve(decodeChunk(PENDING_KEYS.shift() as string));

      return new Promise((resolve) => {
          const stdin = process.stdin;
          const wasRaw = stdin.isRaw;
          let buffer = '';
          let settle: NodeJS.Timeout | null = null;
          let ticker: NodeJS.Timeout | null = null;

          function cleanup(keepRaw: boolean): void {
              if (settle) { clearTimeout(settle); settle = null; }
              if (ticker) { clearTimeout(ticker); ticker = null; }
              stdin.removeListener('data', onData);
              // On a tick we stay in raw mode: restoring and re-entering it between
              // draws would echo a keystroke that lands in the gap.
              if (!keepRaw && stdin.isTTY && !wasRaw) { try { stdin.setRawMode(false); } catch { /* noop */ } }
          }
          function finish(seq: string): void {
              cleanup(false);
              // One read can carry several keys. Resolve the first and keep the rest
              // in order, so nothing the user pressed is discarded.
              const keys = splitKeys(seq);
              if (!keys.length) { resolve({ name: 'unknown', raw: seq }); return; }
              for (let i = keys.length - 1; i >= 1; i--) PENDING_KEYS.unshift(keys[i]);
              resolve(decodeChunk(keys[0]));
          }
          function onData(buf: Buffer | string): void {
              buffer += buf.toString();
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
              if (tickMs > 0) {
                  ticker = setTimeout(() => {
                      cleanup(true);
                      resolve({ name: 'tick', raw: '' });
                  }, tickMs);
              }
          } catch (e) {
              cleanup(false);
              resolve({ name: 'unknown', raw: String((e as Error).message) });
          }
      });
  }

// ── Interactive primitives ─────────────────────────────────────────────────

// Arrow-key menu. `items` = [{label, hint, value, disabled}]; returns the chosen
// item's value, or BACK on Esc, or throws QuitError on Ctrl-C.
  async function menu(items: SelectItem[], opts: MenuOptions = {}): Promise<unknown> {
      const { title, footer, width = termWidth(), pageSize, tickMs = 0, onTick = null, startIndex, above } = opts;
      // A caller that re-draws the SAME list after an action (toggling a checkbox, say)
      // passes startIndex so the cursor stays put. Without it the cursor snaps back to
      // the first row and pressing Enter looks like the menu reset itself.
      let index: number = Number.isInteger(startIndex) && (startIndex as number) >= 0 && (startIndex as number) < items.length
          ? (startIndex as number)
          : Math.max(0, items.findIndex((i) => !i.disabled));
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
          const body: Array<string | BoxBodyItem> = [];
          if (title) body.push(bold(title), '');
          body.push(...rendered);
          if (items.length > size) {
              body.push('');
              body.push(gray(`  ${index + 1}/${items.length}`));
          }
          clear();
          // Anything the caller wants drawn above the menu is re-rendered on every
          // pass, including a timer tick — that is what keeps a live panel live.
          //
          // THIS IS THE ONLY WAY TO PUT ANYTHING ABOVE A MENU. Drawing before calling
          // menu() does not work: clear() runs on every pass, so the text is wiped
          // before the user can read it and only the menu is left on screen. `above`
          // may be an array or a function, and a function is called each pass, which is
          // what lets an animation keep moving while the menu waits.
          let head: string[] = [];
          try {
              head = typeof above === 'function' ? (above() || []) : (above || []);
          } catch { head = []; }
          if (onTick) {
              // A tick that throws must not kill the menu — but it must not be SILENT either.
              // This swallowed an error for the dashboard's whole status panel: cdpAlive has no
