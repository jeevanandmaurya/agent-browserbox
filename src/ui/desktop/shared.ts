import type { Kernel } from '@/client/index';
import { HOME } from '@/client/index';
import { basename, extname, join } from '@/client/index';
import type { Notice } from '@/client/index';
import { isTextLike, kindOf } from '@/apps/files/filetypes';
import type { AppHost } from '../apps';
import { confirmDialog, promptDialog } from '../dialog';
import { h } from '../dom';
import type { WindowManager } from '../wm';

/** Everything a shell (desktop or phone) is built from. */
export interface ShellContext {
  os: Kernel;
  wm: WindowManager;
  apps: AppHost;
  /** Windows live here; it survives switching between shells. */
  area: HTMLElement;
  wall: HTMLElement;
  toasts: HTMLElement;
  notices: Notices;
  mount: HTMLElement;
}

export const DESKTOP_DIR = `${HOME}/Desktop`;

/** Opens a file the way a double-click would: folders in Files, text in Editor, the rest in Preview. */
export function openPath(apps: AppHost, path: string, isDir: boolean): void {
  if (isDir) void apps.launch('files', { path });
  else if (isTextLike(path) && kindOf(path) !== 'markdown' && kindOf(path) !== 'html') void apps.launch('editor', { path });
  else void apps.launch('preview', { path });
}

async function freeName(os: Kernel, dir: string, base: string): Promise<string> {
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length - 1) : base;
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${stem} ${i}${ext ? `.${ext}` : ''}`;
    if (!(await os.fs.exists(join(dir, name)))) return name;
  }
}

export async function newFolder(os: Kernel, dir = DESKTOP_DIR): Promise<void> {
  const name = await promptDialog('New folder', 'Name', await freeName(os, dir, 'New folder'));
  if (name?.trim()) await os.fs.mkdir(join(dir, name.trim()));
}

export async function newTextFile(os: Kernel, apps: AppHost, dir = DESKTOP_DIR): Promise<void> {
  const name = await promptDialog('New text file', 'Name', await freeName(os, dir, 'Untitled.txt'));
  if (!name?.trim()) return;
  const path = join(dir, name.trim());
  await os.fs.writeFile(path, '');
  void apps.launch('editor', { path });
}

export async function renamePath(os: Kernel, path: string): Promise<void> {
  const name = await promptDialog('Rename', 'New name', basename(path));
  if (!name?.trim() || name.trim() === basename(path)) return;
  await os.fs.mv(path, join(path.slice(0, path.lastIndexOf('/')) || '/', name.trim()));
}

export async function deletePath(os: Kernel, path: string): Promise<void> {
  if (await confirmDialog(`Delete ${basename(path)}?`, 'This cannot be undone.', 'Delete', true)) await os.fs.rm(path, { recursive: true });
}

/** Saves files dropped from the computer into a folder. */
export async function importFiles(os: Kernel, files: FileList | File[], dir = DESKTOP_DIR): Promise<number> {
  let n = 0;
  for (const f of files) {
    await os.fs.writeFile(join(dir, await freeName(os, dir, f.name.replace(/[/\\]/g, '_'))), new Uint8Array(await f.arrayBuffer()));
    n++;
  }
  if (n) os.notify({ title: `Copied ${n} file${n === 1 ? '' : 's'} to the desktop`, level: 'ok' });
  return n;
}

export interface NoticeEntry extends Notice {
  at: number;
}

/** Toasts, plus a history for the notification centre. */
export class Notices {
  readonly history: NoticeEntry[] = [];
  unread = 0;
  #listeners = new Set<() => void>();

  constructor(os: Kernel, private toasts: HTMLElement) {
    os.bus.on('notify', (n) => {
      this.history.unshift({ ...n, at: Date.now() });
      this.history.length = Math.min(this.history.length, 50);
      this.unread++;
      this.#changed();
      const t = h('div', { class: `toast ${n.level ?? 'info'}` }, h('strong', null, n.title), n.body ? h('span', null, n.body) : null);
      this.toasts.append(t);
      setTimeout(() => t.remove(), n.level === 'error' ? 8000 : 4500);
    });
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  read(): void {
    this.unread = 0;
    this.#changed();
  }

  clear(): void {
    this.history.length = 0;
    this.unread = 0;
    this.#changed();
  }

  #changed(): void {
    for (const fn of this.#listeners) fn();
  }

  /** The list for a notification centre panel. */
  panel(): HTMLElement {
    const list = h('div', { class: 'nc-list' });
    const render = () =>
      list.replaceChildren(
        ...(this.history.length
          ? this.history.map((n) => h('div', { class: `nc-item ${n.level ?? 'info'}` }, h('div', { class: 'nc-row' }, h('strong', null, n.title), h('time', null, new Date(n.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))), n.body ? h('span', null, n.body) : null))
          : [h('p', { class: 'nc-empty' }, 'No notifications')]),
      );
    render();
    return h('div', { class: 'nc' }, h('div', { class: 'nc-head' }, h('strong', null, 'Notifications'), h('button', { class: 'btn small ghost', type: 'button', onclick: () => (this.clear(), render()) }, 'Clear all')), list);
  }
}

/** A month calendar for the clock's popover. */
export function calendar(date = new Date()): HTMLElement {
  let shown = new Date(date.getFullYear(), date.getMonth(), 1);
  const title = h('strong', null);
  const grid = h('div', { class: 'cal-grid', role: 'grid' });
  const render = () => {
    title.textContent = shown.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const first = (shown.getDay() + 6) % 7; // weeks start on Monday
    const days = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
    const today = new Date();
    const names = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
    grid.replaceChildren(
      ...names.map((n) => h('span', { class: 'cal-dow' }, n)),
      ...[...Array(first)].map(() => h('span')),
      ...[...Array(days)].map((_, i) => {
        const isToday = today.getFullYear() === shown.getFullYear() && today.getMonth() === shown.getMonth() && today.getDate() === i + 1;
        return h('span', { class: `cal-day${isToday ? ' today' : ''}`, 'aria-current': isToday ? 'date' : null }, String(i + 1));
      }),
    );
  };
  const step = (n: number) => {
    shown = new Date(shown.getFullYear(), shown.getMonth() + n, 1);
    render();
  };
  render();
  return h(
    'div',
    { class: 'cal' },
    h('div', { class: 'cal-big' }, h('span', null, date.toLocaleDateString(undefined, { weekday: 'long' })), h('strong', null, date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))),
    h('div', { class: 'cal-head' }, h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Previous month', onclick: () => step(-1) }, '‹'), title, h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Next month', onclick: () => step(1) }, '›')),
    grid,
  );
}

export const clockText = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
