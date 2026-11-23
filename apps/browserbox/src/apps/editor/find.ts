/** Find / replace bar for the editor textarea. */
import { h } from '@/ui/dom';
import { insertText, replaceAll, revealRange } from './textarea';

const MAX_COUNT = 99_999;

export class FindBar {
  readonly el: HTMLElement;
  #query = h('input', { class: 'input', placeholder: 'Find', 'aria-label': 'Find', spellcheck: false });
  #repl = h('input', { class: 'input', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: false });
  #case = h('button', { class: 'btn small ghost', title: 'Match case', 'aria-label': 'Match case', 'aria-pressed': 'false' }, 'Aa');
  #count = h('span', { class: 'find-count muted', 'aria-live': 'polite' });

  constructor(private ta: HTMLTextAreaElement) {
    const btn = (label: string, text: string, fn: () => void) => h('button', { class: 'btn small', title: label, 'aria-label': label, onclick: fn }, text);
    this.#case.addEventListener('click', () => {
      this.#case.setAttribute('aria-pressed', String(this.#case.getAttribute('aria-pressed') !== 'true'));
      this.#updateCount();
    });
    this.#query.addEventListener('input', () => this.#updateCount());
    this.#query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.next(e.shiftKey ? -1 : 1);
      }
    });
    this.#repl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) this.replaceAll();
        else this.replaceOne();
      }
    });
    this.el = h(
      'div',
      {
        class: 'findbar',
        role: 'search',
        hidden: true,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            this.close();
          }
        },
      },
      h('div', { class: 'find-row' }, this.#query, this.#count, this.#case, btn('Previous match (Shift+Enter)', '↑', () => this.next(-1)), btn('Next match (Enter)', '↓', () => this.next(1)), btn('Close find', '✕', () => this.close())),
      h('div', { class: 'find-row' }, this.#repl, btn('Replace (Enter)', 'Replace', () => this.replaceOne()), btn('Replace all (Ctrl+Enter)', 'All', () => this.replaceAll())),
    );
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (sel && !sel.includes('\n')) this.#query.value = sel;
    this.el.hidden = false;
    this.#query.focus();
    this.#query.select();
    this.#updateCount();
  }

  close(): void {
    this.el.hidden = true;
    this.ta.focus();
  }

  /** Re-counts after the buffer changes underneath an open bar. */
  refresh(): void {
    if (this.isOpen) this.#updateCount();
  }

  #regex(): RegExp | null {
    const q = this.#query.value;
    if (!q) return null;
    const flags = this.#case.getAttribute('aria-pressed') === 'true' ? 'g' : 'gi';
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  #updateCount(current?: number): void {
    const re = this.#regex();
    if (!re) return void (this.#count.textContent = '');
    let n = 0;
    let at = 0;
    for (let m = re.exec(this.ta.value); m && n < MAX_COUNT; m = re.exec(this.ta.value)) {
      n++;
      if (current !== undefined && m.index === current) at = n;
    }
    this.#count.textContent = n === 0 ? 'No results' : at ? `${at} of ${n}` : `${n} found`;
  }

  next(dir: 1 | -1): void {
    const re = this.#regex();
    if (!re) return;
    const v = this.ta.value;
    let hit: RegExpExecArray | null = null;
    if (dir > 0) {
      re.lastIndex = this.ta.selectionEnd;
      hit = re.exec(v);
      if (!hit) {
        re.lastIndex = 0;
        hit = re.exec(v);
      }
    } else {
      const before = this.ta.selectionStart;
      let lastBefore: RegExpExecArray | null = null;
      let last: RegExpExecArray | null = null;
      for (let m = re.exec(v); m; m = re.exec(v)) {
        if (m.index < before) lastBefore = m;
        last = m;
      }
      hit = lastBefore ?? last; // wrap around to the final match
    }
    if (!hit) return this.#updateCount();
    revealRange(this.ta, hit.index, hit.index + hit[0].length, this.#query);
    this.#updateCount(hit.index);
  }

  replaceOne(): void {
    const re = this.#regex();
    if (!re) return;
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    re.lastIndex = 0;
    const m = re.exec(sel);
    if (m && m[0] === sel) insertText(this.ta, this.#repl.value);
    this.next(1);
    this.#repl.focus();
  }

  replaceAll(): void {
    const re = this.#regex();
    if (!re) return;
    const count = this.ta.value.match(re)?.length ?? 0;
    if (!count) return void (this.#count.textContent = 'No results');
    const with_ = this.#repl.value;
    replaceAll(this.ta, this.ta.value.replace(re, () => with_));
    this.#count.textContent = `Replaced ${count}`;
    this.#repl.focus();
  }
}
