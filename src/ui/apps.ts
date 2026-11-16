import type { Kernel } from '@/kernel/kernel';
import type { Proc } from '@/kernel/proc';
import { h } from './dom';
import type { WindowHandle, WindowManager } from './wm';

/** What an app receives when it is launched. */
export interface AppContext {
  os: Kernel;
  /** The app's window. `win.body` is the same element as `root`. */
  win: WindowHandle;
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

export interface AppManifest {
  id: string;
  name: string;
  icon: string;
  /** Tile colour for the icon. */
  color: string;
  width: number;
  height: number;
  /** Only one window; launching again focuses it. */
  singleton?: boolean;
  /** Hidden from the launcher (opened by other apps). */
  hidden?: boolean;
  /** Code-split entry: the app's code is only fetched on first launch. */
  load: () => Promise<{ default: AppModule }>;
}

export const APPS: AppManifest[] = [
  { id: 'agent', name: 'Agent', icon: '✦', color: '#7c5cff', width: 860, height: 640, load: () => import('@/apps/agent/index') },
  { id: 'terminal', name: 'Terminal', icon: '❯', color: '#1f2937', width: 760, height: 480, load: () => import('@/apps/terminal/index') },
  { id: 'files', name: 'Files', icon: '🗂', color: '#2563eb', width: 780, height: 500, load: () => import('@/apps/files/index') },
  { id: 'editor', name: 'Editor', icon: '✎', color: '#0d9488', width: 820, height: 560, load: () => import('@/apps/editor/index') },
  { id: 'taskmgr', name: 'Task Manager', icon: '◔', color: '#dc2626', width: 760, height: 500, singleton: true, load: () => import('@/apps/taskmgr/index') },
  { id: 'browser', name: 'Browser', icon: '◍', color: '#0284c7', width: 900, height: 600, load: () => import('@/apps/browser/index') },
  { id: 'gpulab', name: 'GPU Lab', icon: '◈', color: '#c026d3', width: 860, height: 580, load: () => import('@/apps/gpulab/index') },
  { id: 'sysinfo', name: 'System', icon: '⌬', color: '#475569', width: 760, height: 540, singleton: true, load: () => import('@/apps/sysinfo/index') },
  { id: 'settings', name: 'Settings', icon: '⚙', color: '#64748b', width: 720, height: 560, singleton: true, load: () => import('@/apps/settings/index') },
  { id: 'preview', name: 'Preview', icon: '▣', color: '#ea580c', width: 760, height: 540, hidden: true, load: () => import('@/apps/preview/index') },
];

/** Launches apps: creates the window and process, lazy-loads the code, wires cleanup. */
export class AppHost {
  #singletons = new Map<string, WindowHandle>();

  constructor(
    private os: Kernel,
    private wm: WindowManager,
  ) {
    os.bus.on('app:open', ({ id, args }) => void this.launch(id, args));
  }

  async launch(id: string, args: Record<string, unknown> = {}): Promise<void> {
    const app = APPS.find((a) => a.id === id);
    if (!app) return this.os.notify({ title: `No such app: ${id}`, level: 'error' });
    const existing = this.#singletons.get(id);
    if (existing && !existing.closed) {
      if (!Object.keys(args).length) return existing.focus();
      existing.close(); // reopen so the new arguments (e.g. a section deep link) take effect
    }

    const win = this.wm.open({ title: app.name, icon: app.icon, width: app.width, height: app.height });
    win.body.append(h('div', { class: 'app-loading' }, 'Loading…'));
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
