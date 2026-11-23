/** Code-editing behaviour for a plain <textarea>: indentation, auto-indent, gutter, positions. */
import { h } from '@/ui/dom';

const INDENT = '  ';

/** Inserts text at the selection, keeping the browser's native undo stack where possible. */
export function insertText(ta: HTMLTextAreaElement, text: string): void {
  ta.focus();
  // execCommand is deprecated but is still the only way to keep undo/redo working in a textarea.
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Replaces the whole buffer as one undoable edit. */
export function replaceAll(ta: HTMLTextAreaElement, text: string): void {
  ta.focus();
  ta.select();
  insertText(ta, text);
}

function lineStart(v: string, pos: number): number {
  return v.lastIndexOf('\n', pos - 1) + 1;
}

export function countLines(v: string): number {
  let n = 1;
  for (let i = v.indexOf('\n'); i >= 0; i = v.indexOf('\n', i + 1)) n++;
  return n;
}

export function caretPos(v: string, pos: number): { line: number; col: number } {
  return { line: countLines(v.slice(0, pos)), col: pos - lineStart(v, pos) + 1 };
}

function indentLines(ta: HTMLTextAreaElement, outdent: boolean): void {
  const v = ta.value;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const multi = v.slice(s, e).includes('\n');
  if (!outdent && !multi) return insertText(ta, INDENT);
  const from = lineStart(v, s);
  // A selection ending at the very start of a line does not include that line.
  const to = e > s && v[e - 1] === '\n' ? e - 1 : e;
  const nl = v.indexOf('\n', to);
  const end = nl < 0 ? v.length : nl;
  let first = 0;
  let total = 0;
  const out = v
    .slice(from, end)
    .split('\n')
    .map((l, i) => {
      const cut = outdent ? (/^( {1,2}|\t)/.exec(l)?.[0].length ?? 0) : 0;
      const d = outdent ? -cut : INDENT.length;
      if (i === 0) first = d;
      total += d;
      return outdent ? l.slice(cut) : INDENT + l;
    })
    .join('\n');
  if (total === 0) return;
  ta.setSelectionRange(from, end);
  insertText(ta, out);
  ta.setSelectionRange(Math.max(from, s + first), Math.max(from, e + total));
}

function newline(ta: HTMLTextAreaElement, lang: string): void {
  const v = ta.value;
  const s = ta.selectionStart;
  const line = v.slice(lineStart(v, s), s);
  const ind = /^[ \t]*/.exec(line)![0];
  const last = line.trimEnd().slice(-1);
  const next = v[ta.selectionEnd] ?? '';
  if (last && '{[('.includes(last)) {
    const inner = ind + INDENT;
    if (next && next === { '{': '}', '[': ']', '(': ')' }[last]) {
      insertText(ta, `\n${inner}\n${ind}`);
      const caret = s + 1 + inner.length;
      ta.setSelectionRange(caret, caret);
    } else insertText(ta, `\n${inner}`);
  } else if (last === ':' && lang === 'Python') insertText(ta, `\n${ind}${INDENT}`);
  else insertText(ta, `\n${ind}`);
}

/**
 * Tab / Shift+Tab / Enter handling. Escape releases the Tab key once so
 * keyboard users can still move focus out of the editor.
 */
export function attachEditing(ta: HTMLTextAreaElement, language: () => string): void {
  let releaseTab = false;
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || ta.readOnly) return;
    if (e.key === 'Escape') {
      releaseTab = true;
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (releaseTab) return;
      e.preventDefault();
      indentLines(ta, e.shiftKey);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      newline(ta, language());
    }
    releaseTab = false;
  });
  ta.addEventListener('blur', () => (releaseTab = false));
}

/** Line-number gutter kept in sync with the textarea's line count and scroll position. */
export class Gutter {
  readonly el = h('div', { class: 'gutter', 'aria-hidden': 'true' });
  #inner = h('div', { class: 'gutter-inner' });
  #lines = 0;

  constructor() {
    this.el.append(this.#inner);
  }

  update(value: string): void {
    const n = countLines(value);
    if (n === this.#lines) return;
    this.#lines = n;
    this.#inner.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  }

  sync(ta: HTMLTextAreaElement): void {
    this.#inner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }
}

/** Moves the caret to the start of a 1-based line and scrolls it into view. */
export function gotoLine(ta: HTMLTextAreaElement, line: number): void {
  const v = ta.value;
  let pos = 0;
  for (let n = 1; n < line; n++) {
    const nl = v.indexOf('\n', pos);
    if (nl < 0) break;
    pos = nl + 1;
  }
  revealRange(ta, pos, pos);
}

/** Selects a range and scrolls the textarea so it is visible. */
export function revealRange(ta: HTMLTextAreaElement, start: number, end: number, keepFocus?: HTMLElement): void {
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, end);
  if (ta.wrap === 'off') {
    const lh = Number.parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const line = caretPos(ta.value, start).line;
    const top = (line - 1) * lh;
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lh * 2) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  } else {
    // Re-focusing makes the browser scroll the caret into view for wrapped text.
    ta.blur();
    ta.focus();
  }
  keepFocus?.focus();
}
