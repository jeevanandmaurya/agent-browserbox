/** The sortable, multi-select file list. Owns rendering, selection and arrow-key navigation. */
import type { Stat } from '@jeevanand/agent-browserbox-runtime/client';
import { fmtBytes, fmtTime, h } from '@/ui/dom';
import { icon } from '@/ui/icons';
import { iconFor } from './filetypes';

export type SortKey = 'name' | 'size' | 'mtime';

export interface TableHooks {
  open(entry: Stat): void;
  /** Context menu at client coords; `onRow` is false for the empty background. */
  menu(x: number, y: number, onRow: boolean): void;
  selectionChanged(): void;
}

const COLS: Array<[SortKey, string]> = [['name', 'Name'], ['size', 'Size'], ['mtime', 'Modified']];
let uid = 0;

export class FileTable {
  readonly el: HTMLElement;
  entries: Stat[] = [];
  readonly selected = new Set<string>();
  sort: { key: SortKey; dir: 1 | -1 } = { key: 'name', dir: 1 };
  /** Paths shown dimmed because they are on the clipboard for a move. */
  cut = new Set<string>();
  #id = `ft${++uid}`;
  #tbody = h('tbody');
  #thead = h('thead');
  #table = h('table', { class: 'table files-table', role: 'grid', 'aria-multiselectable': 'true', 'aria-label': 'Files' }, this.#thead, this.#tbody);
  #empty = h('div', { class: 'empty files-empty' }, h('div', null, h('div', { class: 'files-empty-icon' }, icon('folder', 32)), h('p', null, 'This folder is empty.'), h('p', { class: 'muted' }, 'Drop files here, or use New file / Upload.')));
  #rows: HTMLTableRowElement[] = [];
  #anchor = -1;
  #cursor = -1;
  #touch = false;

  constructor(private hooks: TableHooks) {
    this.el = h('div', { class: 'files-pane fill', tabindex: 0 }, this.#table, this.#empty);
    this.#renderHead();
    this.el.addEventListener('pointerdown', (e) => (this.#touch = e.pointerType === 'touch'));
    this.el.addEventListener('click', (e) => this.#click(e));
    this.el.addEventListener('dblclick', (e) => {
      const i = this.#rowIndex(e);
      if (i >= 0) this.hooks.open(this.entries[i]!);
    });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const i = this.#rowIndex(e);
      if (i >= 0 && !this.selected.has(this.entries[i]!.path)) this.#selectOnly(i);
      else if (i < 0) this.clear();
      this.hooks.menu(e.clientX, e.clientY, i >= 0);
    });
    this.el.addEventListener('keydown', (e) => this.#key(e));
  }

  #rowIndex(e: Event): number {
    const tr = (e.target as Element).closest?.('tbody tr') as HTMLTableRowElement | null;
    return tr ? this.#rows.indexOf(tr) : -1;
  }

  /** Replaces the listing, keeping still-present selected paths. */
  set(entries: Stat[]): void {
    this.entries = entries;
    const present = new Set(entries.map((e) => e.path));
    for (const p of [...this.selected]) if (!present.has(p)) this.selected.delete(p);
    this.#render();
  }

  get selection(): Stat[] {
    return this.entries.filter((e) => this.selected.has(e.path));
  }

  select(paths: string[]): void {
    this.selected.clear();
    paths.forEach((p) => this.selected.add(p));
    const i = this.entries.findIndex((e) => this.selected.has(e.path));
    this.#cursor = this.#anchor = i;
    this.#paint();
    this.#rows[i]?.scrollIntoView({ block: 'nearest' });
  }

  clear(): void {
    this.selected.clear();
    this.#paint();
  }

  /** The row the keyboard cursor is on, for anchoring keyboard-opened menus. */
  get cursorRow(): HTMLElement | null {
    return this.#rows[this.#cursor] ?? this.#rows.find((r) => r.classList.contains('selected')) ?? null;
  }

  #sorted(): Stat[] {
    const { key, dir } = this.sort;
    const byName = (a: Stat, b: Stat) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return [...this.entries].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      const d = key === 'name' ? byName(a, b) : (a[key] - b[key]) || byName(a, b);
      return d * dir;
    });
  }

  #renderHead(): void {
    this.#thead.replaceChildren(
      h(
        'tr',
        null,
        COLS.map(([key, label]) => {
          const active = this.sort.key === key;
          return h(
            'th',
            { class: `col-${key}`, 'aria-sort': active ? (this.sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
            h('button', { class: 'sort-btn', onclick: () => this.#sortBy(key) }, label, active ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : ''),
          );
        }),
      ),
    );
  }

  #sortBy(key: SortKey): void {
    this.sort = { key, dir: this.sort.key === key ? (-this.sort.dir as 1 | -1) : 1 };
    this.#renderHead();
    this.#render();
  }

  #render(): void {
    this.entries = this.#sorted();
    this.#rows = this.entries.map((e, i) =>
      h(
        'tr',
        { id: `${this.#id}-${i}`, role: 'row' },
        h('td', { class: 'col-name', role: 'gridcell' }, h('span', { class: `ficon ${e.kind}`, 'aria-hidden': 'true' }, icon(iconFor(e.name, e.kind === 'dir'), 16)), h('span', { class: 'fname', title: e.name }, e.name)),
        h('td', { class: 'col-size', role: 'gridcell' }, e.kind === 'dir' ? '—' : fmtBytes(e.size)),
        h('td', { class: 'col-mtime', role: 'gridcell' }, fmtTime(e.mtime)),
      ),
    );
    this.#tbody.replaceChildren(...this.#rows);
    this.#table.hidden = !this.entries.length;
    this.#empty.hidden = !!this.entries.length;
    // Indices change with every listing/sort, so re-derive the cursor from the selection.
    this.#cursor = this.#anchor = this.entries.findIndex((e) => this.selected.has(e.path));
    this.#paint();
  }

  #paint(): void {
    this.#rows.forEach((tr, i) => {
      const p = this.entries[i]!.path;
      const sel = this.selected.has(p);
      tr.classList.toggle('selected', sel);
      tr.classList.toggle('cut', this.cut.has(p));
      tr.classList.toggle('cursor', i === this.#cursor);
      tr.setAttribute('aria-selected', String(sel));
    });
    if (this.#cursor >= 0) this.el.setAttribute('aria-activedescendant', `${this.#id}-${this.#cursor}`);
    else this.el.removeAttribute('aria-activedescendant');
    this.hooks.selectionChanged();
  }

  /** Re-applies classes after the clipboard changes. */
  repaint(): void {
    this.#paint();
  }

  #selectOnly(i: number): void {
    this.selected.clear();
    this.selected.add(this.entries[i]!.path);
    this.#anchor = this.#cursor = i;
    this.#paint();
  }

  #selectRange(to: number, additive: boolean): void {
    if (!additive) this.selected.clear();
    const from = this.#anchor < 0 ? to : this.#anchor;
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) this.selected.add(this.entries[i]!.path);
    this.#cursor = to;
    this.#paint();
  }

  #click(e: MouseEvent): void {
    const i = this.#rowIndex(e);
    if (i < 0) {
      if (!(e.target as Element).closest('thead')) this.clear();
      return;
    }
    const path = this.entries[i]!.path;
    if (e.shiftKey) this.#selectRange(i, e.ctrlKey || e.metaKey);
    else if (e.ctrlKey || e.metaKey) {
      if (!this.selected.delete(path)) this.selected.add(path);
      this.#anchor = this.#cursor = i;
      this.#paint();
    } else if (this.#touch && this.selected.size === 1 && this.selected.has(path)) {
      // Touch has no reliable double-click: tapping the selected item opens it.
      this.hooks.open(this.entries[i]!);
    } else this.#selectOnly(i);
  }

  #key(e: KeyboardEvent): void {
    const n = this.entries.length;
    const mod = e.ctrlKey || e.metaKey;
    let to = -1;
    if (e.key === 'ArrowDown') to = Math.min(n - 1, this.#cursor + 1);
    else if (e.key === 'ArrowUp') to = Math.max(0, this.#cursor < 0 ? 0 : this.#cursor - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.entries.forEach((x) => this.selected.add(x.path));
      return this.#paint();
    } else if (e.key === 'Escape' && this.selected.size) {
      e.preventDefault();
      return this.clear();
    } else return;
    e.preventDefault();
    if (to < 0) return;
    if (e.shiftKey) this.#selectRange(to, mod);
    else this.#selectOnly(to);
    this.#rows[to]?.scrollIntoView({ block: 'nearest' });
  }
}
