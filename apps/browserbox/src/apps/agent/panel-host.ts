import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { APPS, type AppContext, type AppModule, type AppWindow } from '@/ui/apps';
import { h } from '@/ui/dom';
import { loader } from '@/ui/icons';

export interface PanelApp {
  readonly id: string;
  readonly win: AppWindow;
  /** Becomes true while the pane is not on screen (apps pause timers on `win.minimized`). */
  setHidden(hidden: boolean): void;
  close(): void;
}

export interface PanelHostOptions {
  /** Routes the app's own `ctx.launch` calls (e.g. Files → Editor). */
  launch(id: string, args: Record<string, unknown>): void;
  /** Called when the app closes itself or its process is killed. */
  onClosed(): void;
  /** Called when the app sets its title. */
  onTitle?(title: string): void;
  /** Called when the app says what it shows now (see AppWindow.setArgs). */
  onArgs?(args: Record<string, unknown>): void;
}

/**
 * Mounts an app module into a pane of the agent window — the in-page
 * counterpart of `mountStandalone` and the desktop's AppHost. The app gets a
 * window-like object, its own kernel process, and cleanup when it closes.
 */
export function mountPanelApp(os: Kernel, id: string, pane: HTMLElement, args: Record<string, unknown>, opts: PanelHostOptions): PanelApp {
  const manifest = APPS.find((a) => a.id === id);
  const closers: Array<() => void> = [];
  const unsubs: Array<() => void> = [];
  let hidden = false;
  pane.replaceChildren(h('div', { class: 'app-loading' }, loader(32)));
  pane.dataset.app = id;

  const proc = os.procs.spawn({ name: manifest?.name ?? id, kind: 'app', detail: `${id} (agent window)`, onKill: () => win.close() });
  os.procs.update(proc.pid, { state: 'idle' });

  const win: AppWindow = {
    body: pane,
    title: manifest?.name ?? id,
    closed: false,
    get minimized() {
      return hidden || document.hidden;
    },
    set minimized(_v: boolean) {
      /* panes are hidden by the workbench, not by apps */
    },
    setTitle(title) {
      this.title = title;
      opts.onTitle?.(title);
    },
    focus: () => opts.launch(id, {}),
    close() {
      if (this.closed) return;
      this.closed = true;
      unsubs.splice(0).forEach((u) => u());
      closers.splice(0).forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error(`[panel] ${id} cleanup failed`, err);
        }
      });
      os.procs.exit(proc.pid);
      pane.replaceChildren();
      opts.onClosed();
    },
    onClose: (fn) => void closers.push(fn),
    setArgs: (next) => opts.onArgs?.(next),
  };

  const ctx: AppContext = {
    os,
    win,
    root: pane,
    args,
    proc,
    launch: (other, a) => opts.launch(other, a ?? {}),
    on: (type, fn) => {
      const off = os.bus.on(type, fn);
      unsubs.push(off);
      return off;
    },
  };

  void (async () => {
    try {
      if (!manifest?.load) throw new Error(`${id} cannot be embedded here`);
      const mod: AppModule = (await manifest.load()).default;
      if (win.closed) return;
      pane.replaceChildren();
      const cleanup = await mod.mount(ctx);
      if (typeof cleanup === 'function') {
        if (win.closed) cleanup();
        else closers.push(cleanup);
      }
    } catch (err) {
      console.error(`[panel] ${id} failed`, err);
      if (!win.closed) pane.replaceChildren(h('div', { class: 'app-error' }, h('strong', null, `${manifest?.name ?? id} failed to start`), h('pre', null, String((err as Error)?.message ?? err))));
    }
  })();

  return {
    id,
    win,
    setHidden: (v) => (hidden = v),
    close: () => win.close(),
  };
}
