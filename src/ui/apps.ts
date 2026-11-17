import { APP_MANIFESTS, type AppManifest } from './app-manifest';
import type { Kernel } from '@/kernel/api';
import type { Proc } from '@/kernel/proc';
import { h } from './dom';
import { loader } from './icons';
import type { WindowManager } from './wm';

/** The part of a window an app may rely on. A desktop window and a standalone page both provide it. */
export interface AppWindow {
  readonly body: HTMLElement;
  title: string;
  closed: boolean;
  minimized: boolean;
  setTitle(title: string): void;
  focus(): void;
  close(): void;
  onClose(fn: () => void): void;
}

/** What an app receives when it is launched. */
export interface AppContext {
  os: Kernel;
  /** The app's window. `win.body` is the same element as `root`. */
  win: AppWindow;
  root: HTMLElement;
  /** Launch arguments, e.g. `{ path: '/home/user/a.txt' }`. */
  args: Record<string, unknown>;
  /** The app's process; `proc.signal` aborts when the window closes or the process is killed. */
  proc: Proc;
  /** Launch another app. */
  launch(id: string, args?: Record<string, unknown>): void;
  /** Subscribe to kernel events; automatically unsubscribed on close. */
  on: Kernel['bus']['on'];
}

export interface AppModule {
  /** Render into `ctx.root`. May return a cleanup function. */
  mount(ctx: AppContext): void | (() => void) | Promise<void | (() => void)>;
}

export type { AppManifest } from './app-manifest';

const loaders = import.meta.glob<{ default: AppModule }>('/src/apps/*/index.ts');

/** Every app, from its folder's manifest; `load` fetches its code on first launch. */
export const APPS: Array<AppManifest & { load?: () => Promise<{ default: AppModule }> }> = APP_MANIFESTS.map((m) => ({
  ...m,
  load: m.external ? undefined : loaders[`/src/apps/${m.id}/index.ts`],
}));

/** Launches apps: creates the window and process, lazy-loads the code, wires cleanup. */
export class AppHost {
  #singletons = new Map<string, AppWindow>();

  constructor(
    private os: Kernel,
    private wm: WindowManager,
  ) {
    os.bus.on('app:open', ({ id, args }) => void this.launch(id, args));
  }

  async launch(id: string, args: Record<string, unknown> = {}): Promise<void> {
    const app = APPS.find((a) => a.id === id);
    if (!app) return this.os.notify({ title: `No such app: ${id}`, level: 'error' });
    if (app.external || !app.load) {
      // Its own browser tab (named, so a second launch returns to the same tab), not a window inside this page.
      if (!open(app.external, `bbx-${id}`)) this.os.notify({ title: `Allow pop-ups to open ${app.name}`, body: 'The browser blocked the new window.', level: 'warn' });
      return;
    }
    const existing = this.#singletons.get(id);
    if (existing && !existing.closed) {
      if (!Object.keys(args).length) return existing.focus();
      existing.close(); // reopen so the new arguments (e.g. a section deep link) take effect
    }

    const win = this.wm.open({ title: app.name, icon: app.icon, width: app.width, height: app.height });
    win.body.append(h('div', { class: 'app-loading' }, loader(32, `Loading ${app.name}`)));
    const proc = this.os.procs.spawn({ name: app.name, kind: 'app', detail: app.id, onKill: () => win.close() });
    this.os.procs.update(proc.pid, { state: 'idle' });
    const unsubs: Array<() => void> = [];
    win.onClose(() => {
      unsubs.forEach((u) => u());
      this.os.procs.exit(proc.pid);
      if (this.#singletons.get(id) === win) this.#singletons.delete(id);
    });
    if (app.singleton) this.#singletons.set(id, win);

    const ctx: AppContext = {
      os: this.os,
      win,
      root: win.body,
      args,
      proc,
      launch: (other, a) => void this.launch(other, a),
      on: (type, fn) => {
        const off = this.os.bus.on(type, fn);
        unsubs.push(off);
        return off;
      },
    };
    try {
      const mod = (await app.load()).default;
      if (win.closed) return;
      win.body.replaceChildren();
      win.body.dataset.app = id;
      const cleanup = await mod.mount(ctx);
      if (typeof cleanup === 'function') win.onClose(cleanup);
    } catch (err) {
      console.error(`[apps] ${id} failed`, err);
      if (!win.closed) win.body.replaceChildren(h('div', { class: 'app-error' }, h('strong', null, `${app.name} failed to start`), h('pre', null, String((err as Error)?.stack ?? err))));
    }
  }
}
