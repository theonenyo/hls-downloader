// Copied from callrec's lib/term.mjs, with an `input` widget added at the end.
// Tiny terminal toolkit: colors, in-place redraw, key handling, arrow-key menu. No dependencies.
import readline from 'node:readline';

const out = process.stdout;
// A closed terminal makes every write fail (EIO/EPIPE); never let that crash a recording in progress.
for (const st of [process.stdout, process.stderr, process.stdin]) st.on('error', () => {});
const safe = (fn) => { try { fn(); } catch {} };
const color = out.isTTY && !process.env.NO_COLOR;
const code = (n) => (color ? `\x1b[${n}m` : '');

export const s = {
  bold: (t) => `${code(1)}${t}${code(22)}`,
  dim: (t) => `${code(2)}${t}${code(22)}`,
  red: (t) => `${code(31)}${t}${code(39)}`,
  green: (t) => `${code(32)}${t}${code(39)}`,
  yellow: (t) => `${code(33)}${t}${code(39)}`,
  cyan: (t) => `${code(36)}${t}${code(39)}`,
  gray: (t) => `${code(90)}${t}${code(39)}`,
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visibleLength = (t) => t.replace(ANSI, '').length;

// Cut a string to `max` visible characters without breaking escape codes.
export function clip(t, max) {
  if (visibleLength(t) <= max) return t;
  let n = 0, res = '', i = 0;
  while (i < t.length && n < max) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(t);
    if (m && m.index === i) { res += m[0]; i += m[0].length; continue; }
    res += t[i++]; n++;
  }
  return res + (color ? '\x1b[0m' : '');
}

// Word-wrap plain text to the terminal width; continuation lines get `indent` spaces.
export function wrap(text, indent = 4, first = '') {
  const width = Math.max(30, Math.min(fullscreen ? MAX_TEXT_WIDTH : Infinity, (out.columns || 80) - 2 - indent));
  const lines = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur && cur.length + 1 + w.length > width) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  lines.push(cur);
  return lines.map((l, n) => (n === 0 ? first : ' '.repeat(indent)) + l);
}

export const hideCursor = () => color && out.write('\x1b[?25l');
export const showCursor = () => color && out.write('\x1b[?25h');

// MARK: full screen

// The alternate screen buffer takes over the whole window (like vim/htop) and restores the shell untouched on exit.
let fullscreen = false;
const liveFrames = new Set();
const INDENT = 2; // every screen line starts with this many spaces
const MIN_BLOCK_WIDTH = 60;
const MAX_TEXT_WIDTH = 62; // wrapped warnings stop here in full screen, so one long message doesn't stretch the block

export function enterScreen() {
  if (fullscreen || !out.isTTY) return;
  fullscreen = true;
  out.write('\x1b[?1049h\x1b[2J\x1b[H');
}

export function leaveScreen() {
  if (!fullscreen) return;
  fullscreen = false;
  liveFrames.clear();
  out.write('\x1b[?25h\x1b[?1049l');
}

out.on('resize', () => {
  if (!fullscreen) return;
  out.write('\x1b[2J');
  for (const f of liveFrames) f.paint();
});

// A block of lines that is redrawn in place instead of scrolling. Full screen: painted from the top-left corner.
export class Frame {
  constructor() { this.rows = 0; this.last = []; this.reset(); }
  reset() { this.w = 0; this.h = 0; this.pos = null; }
  // Centered both ways. The block only ever grows while open (and has a minimum width), so it doesn't jump around
  // when a warning line appears or a number changes width.
  paint() {
    const cols = out.columns || 80, rows = out.rows || 24;
    const lines = this.last.slice(0, rows);
    this.w = Math.min(cols - 1, Math.max(this.w, MIN_BLOCK_WIDTH, ...lines.map(visibleLength)));
    this.h = Math.min(rows, Math.max(this.h, lines.length));
    const left = Math.max(0, Math.floor((cols - (this.w - INDENT)) / 2) - INDENT); // center the text, not its 2-space indent
    const top = Math.max(0, Math.floor((rows - this.h) / 2));
    let buf = '';
    if (this.pos !== `${left},${top}`) { buf += '\x1b[2J'; this.pos = `${left},${top}`; } // moved: wipe the old position
    lines.forEach((l, n) => { buf += `\x1b[${top + n + 1};${left + 1}H${clip(l, cols - left - 1)}\x1b[K`; });
    out.write(buf + '\x1b[J');
  }
  draw(lines) {
    if (fullscreen) { this.last = lines; liveFrames.add(this); return this.paint(); }
    const width = Math.max(20, (out.columns || 80) - 1);
    let buf = this.rows ? `\x1b[${this.rows}F` : '';
    for (const l of lines) buf += clip(l, width) + '\x1b[K\n';
    const extra = this.rows - lines.length;
    if (extra > 0) buf += '\x1b[K\n'.repeat(extra) + `\x1b[${extra}F`;
    this.rows = lines.length;
    out.write(buf);
  }
  // Erase the block entirely (the cursor ends up where the block started).
  clear() {
    if (liveFrames.delete(this)) { this.last = []; this.reset(); out.write('\x1b[2J\x1b[H'); return; }
    if (this.rows) out.write(`\x1b[${this.rows}F\x1b[J`);
    this.rows = 0;
  }
}

// MARK: keys

let keysReady = false;
// Calls handler(name, key) for every key press; returns a function that stops listening.
export function onKeys(handler) {
  const stdin = process.stdin;
  if (!keysReady) { readline.emitKeypressEvents(stdin); keysReady = true; }
  if (stdin.isTTY) safe(() => stdin.setRawMode(true));
  stdin.resume();
  const fn = (str, key = {}) => {
    const name = key.ctrl && key.name === 'c' ? 'ctrl-c' : key.name ?? str;
    handler(name, key, str);
  };
  stdin.on('keypress', fn);
  return () => {
    stdin.off('keypress', fn);
    if (stdin.isTTY) safe(() => stdin.setRawMode(false));
    stdin.pause();
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MARK: menu

// items: [{ label, hint?, key?, value }]. Resolves to the chosen item, or null on Esc/q (and 'quit' on Ctrl-C).
// `header()` may return fresh lines on every draw. Hotkeys: an item's `key` picks it immediately.
export function select({ header = () => [], items, footer = '↑↓ move · enter select · esc back', start = 0 }) {
  return new Promise((resolve) => {
    const frame = new Frame();
    let i = Math.min(start, items.length - 1);
    const render = () => {
      const lines = [...header(), ''];
      items.forEach((it, n) => {
        const on = n === i;
        const label = on ? s.bold(s.cyan(it.label)) : it.label;
        lines.push(`  ${on ? s.cyan('▸') : ' '} ${label}${it.hint ? '  ' + s.gray(it.hint) : ''}`);
      });
      lines.push('', '  ' + s.gray(footer));
      frame.draw(lines);
    };
    hideCursor();
    render();
    const done = (value) => { off(); frame.clear(); showCursor(); resolve(value); };
    const off = onKeys((name) => {
      if (name === 'up' || name === 'k') i = (i + items.length - 1) % items.length;
      else if (name === 'down' || name === 'j') i = (i + 1) % items.length;
      else if (name === 'return') return done(items[i]);
      else if (name === 'escape' || name === 'q') return done(null);
      else if (name === 'ctrl-c') return done('quit');
      else {
        const hot = items.find((it) => it.key === name);
        if (hot) return done(hot);
      }
      render();
    });
  });
}

// Animated spinner on a single line while `promise` runs.
export async function withSpinner(text, promise) {
  if (!out.isTTY) return promise;
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let n = 0;
  hideCursor();
  // Full screen: dead center of the window. Otherwise: the current line.
  const home = () => (fullscreen
    ? `\x1b[${Math.floor((out.rows || 24) / 2)};${Math.max(1, Math.floor(((out.columns || 80) - text.length - 2) / 2) + 1)}H`
    : '\r  ');
  const t = setInterval(() => out.write(`${home()}${s.cyan(frames[n++ % frames.length])} ${s.gray(text)}\x1b[K`), 80);
  try { return await promise; } finally {
    clearInterval(t);
    out.write(`${fullscreen ? '\x1b[2K\r' : '\r\x1b[K'}`);
    showCursor();
  }
}

// MARK: text input

// One-line text field. Resolves to the trimmed text, or null on Esc / Ctrl-C.
// `validate(text)` may return an error message, which keeps the field open.
export function input({ header = () => [], value = '', placeholder = '', footer = 'enter ok · ctrl-u clear · esc back', validate }) {
  return new Promise((resolve) => {
    const frame = new Frame();
    let v = value, err = '';
    const render = () => {
      const cols = out.columns || 80;
      const room = Math.max(20, Math.min(fullscreen ? MAX_TEXT_WIDTH + 8 : Infinity, cols - 8));
      const shown = v.length > room ? '…' + v.slice(-(room - 1)) : v; // long URLs: keep the end in view
      const caret = color ? '\x1b[7m \x1b[27m' : '_';
      const text = v ? shown : s.gray(placeholder);
      const lines = [...header(), '', `  ${s.cyan('›')} ${v ? text + caret : caret + text}`];
      if (err) lines.push(...wrap(err, 4, '  ').map(s.red));
      lines.push('', '  ' + s.gray(footer));
      frame.draw(lines);
    };
    hideCursor();
    render();
    const done = (val) => { off(); frame.clear(); showCursor(); resolve(val); };
    const off = onKeys((name, key, str) => {
      if (name === 'return' || name === 'enter') {
        const t = v.trim();
        const e = validate?.(t);
        if (e) { err = e; return render(); }
        return done(t);
      }
      if (name === 'escape' || name === 'ctrl-c') return done(null);
      if (name === 'backspace') v = v.slice(0, -1);
      else if (key.ctrl && name === 'u') v = '';
      else if (key.ctrl && name === 'w') v = v.replace(/\S*\s*$/, '');
      else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) v += str;
      else return;
      err = '';
      render();
    });
  });
}
