import { OS_URL } from '@/config/origins';
import type { RemoteKernel as Kernel } from '@/client/remote-kernel';
import type { PermDecision, PermRequest } from '@/kernel/perms';
import type { AppContext, AppModule, AppWindow } from './apps';
import { permissionDialog } from './dialog';
import { h } from './dom';

const THEME_KEY = 'bbx-theme';

/** Paints the right theme before the kernel has answered, then follows the setting. */
export function followTheme(os: Kernel): void {
  const root = document.documentElement;
  try {
    root.dataset.theme = localStorage.getItem(THEME_KEY) ?? 'dark';
  } catch {
    root.dataset.theme = 'dark';
  }
  os.bus.on('settings:change', ({ key, value }) => {
    if (key !== 'ui.theme') return;
    root.dataset.theme = String(value ?? 'dark');
    try {
      localStorage.setItem(THEME_KEY, root.dataset.theme);
    } catch {
      /* storage blocked */
    }
  });
}

/** Toasts for kernel notifications; returns a function for toasts with an action button. */
export function mountToasts(os: Kernel): (title: string, body: string, action: { label: string; run: () => void }) => void {
  const box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.append(box);
  const show = (el: HTMLElement, ms: number) => {
    box.append(el);
    setTimeout(() => el.remove(), ms);
  };
  os.bus.on('notify', (n) => show(h('div', { class: `toast ${n.level ?? 'info'}` }, h('strong', null, n.title), n.body ? h('span', null, n.body) : null), n.level === 'error' ? 8000 : 4500));
  return (title, body, action) => {
    const el = h('div', { class: 'toast action' }, h('strong', null, title), h('span', null, body));
    el.append(
      h(
        'button',
        {
          class: 'btn small primary',
          onclick: () => {
            el.remove();
            action.run();
          },
        },
        action.label,
      ),
    );
    show(el, 20000);
  };
}

export const dialogPrompter = (req: PermRequest, signal?: AbortSignal): Promise<PermDecision> => permissionDialog(req, signal);

const desktopOpen = (os: Kernel) => os.procs.list().some((p) => p.name === 'desktop' && p.kind === 'service');

/**
 * Opens an app in the desktop GUI, starting the desktop in its own window if
 * it is not running. Must be called from a user gesture when it has to open
 * a window, or the browser's pop-up blocker will stop it.
 */
export function openInDesktop(os: Kernel, id: string, args: Record<string, unknown> = {}): void {
  if (desktopOpen(os)) return os.openApp(id, args);
  if (!open(OS_URL, 'bbx-os')) return os.notify({ title: 'Allow pop-ups to open the desktop', level: 'warn' });
  const off = os.bus.on('proc:spawn', (p) => {
    if (p.name !== 'desktop') return;
    off();
    os.openApp(id, args);
  });
}

/**
 * Runs a single app as a whole page, with no desktop and no window manager.
 * This is how the agent gets its own real browser window.
 */
export async function mountStandalone(os: Kernel, app: AppModule, name: string, root: HTMLElement, opts: { embedsApps?: boolean } = {}): Promise<void> {
  const offer = mountToasts(os);
  os.perms.setPrompter(dialogPrompter);
  await os.ready;
  const closers: Array<() => void> = [];
  const proc = os.procs.spawn({ name: `${name} window`, kind: 'app', detail: 'standalone', onKill: () => close() });
  os.procs.update(proc.pid, { state: 'idle' });
  const win: AppWindow = {
    body: root,
    title: name,
    closed: false,
    get minimized() {
      return document.hidden;
    },
    setTitle(title) {
      this.title = document.title = `${title} — BrowserBox`;
    },
    focus: () => focus(),
    close: () => close(),
    onClose: (fn) => void closers.push(fn),
  };
  // The kernel (or the agent) asked for an app: hand it to the desktop, or offer to start one.
  // Pages that host apps themselves (the agent window's workbench) handle `app:open` on their own.
  if (!opts.embedsApps)
    os.bus.on('app:open', ({ id, args }) => {
      if (!desktopOpen(os)) offer('The agent wants to show you something', `Open ${id} in the desktop`, { label: 'Open desktop', run: () => openInDesktop(os, id, args) });
    });
  const ctx: AppContext = { os, win, root, args: Object.fromEntries(new URLSearchParams(location.search)), proc, launch: (id, args) => openInDesktop(os, id, args), on: (type, fn) => os.bus.on(type, fn) };
  root.dataset.app = name.toLowerCase();
  const cleanup = await app.mount(ctx);
  if (typeof cleanup === 'function') closers.push(cleanup);
  addEventListener('pagehide', () => closers.splice(0).forEach((fn) => fn()));
}
