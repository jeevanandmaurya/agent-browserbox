import { OS_URL } from '@/app/config';
import { profileWindow, withProfile } from '@/app/boot';
import type { RemoteKernel as Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import type { PermDecision, PermRequest } from '@jeevanand/agent-browserbox-runtime/client';
import type { AppContext, AppModule, AppWindow } from './apps';
import { permissionDialog } from './dialog';
import { h } from './dom';

const THEME_KEY = 'bbx-theme';
/** The last theme's colours and darkness, to paint them before anything loads. */
const THEME_CACHE = 'bbx-theme-paint';

/**
 * Paints the theme before the kernel has answered (from the last one used),
 * then follows the `ui.theme` setting: a theme id, 'system' (Graphite, as the
 * device prefers, live), or the older 'dark' and 'light'. The themes' colours
 * load after startup.
 */
export function followTheme(os: Kernel): void {
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  const store = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage blocked */
    }
  };
  try {
    choice = localStorage.getItem(THEME_KEY) ?? 'system';
    const cached = JSON.parse(localStorage.getItem(THEME_CACHE) ?? 'null') as { dark: boolean; vars: string } | null;
    if (cached) {
      root.dataset.theme = cached.dark ? 'dark' : 'light';
      root.style.cssText = cached.vars;
    } else root.dataset.theme = choice === 'light' || (choice === 'system' && !dark.matches) ? 'light' : 'dark';
  } catch {
    /* storage blocked */
  }
  const themes = import('./themes');
  const paint = () =>
    void themes.then(({ resolveTheme, themeVars }) => {
      const t = resolveTheme(choice, dark.matches);
      const vars = themeVars(t);
      root.dataset.theme = t.dark ? 'dark' : 'light';
      root.style.cssText = vars;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.palette.panel);
      store(THEME_CACHE, JSON.stringify({ dark: t.dark, vars }));
    });
  const choose = (value: unknown) => {
    choice = typeof value === 'string' && value ? value : 'system';
    store(THEME_KEY, choice);
    paint();
  };
  paint();
  dark.addEventListener('change', paint);
  os.bus.on('settings:change', ({ key, value }) => key === 'ui.theme' && choose(value));
  void os.ready.then(() => choose(os.settings.get<string>('ui.theme', choice)), () => undefined);
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
  if (!open(withProfile(OS_URL), profileWindow('bbx-os'))) return os.notify({ title: 'Allow pop-ups to open the desktop', level: 'warn' });
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
export async function mountStandalone(os: Kernel, app: AppModule, name: string, root: HTMLElement, opts: { embedsApps?: boolean; args?: Record<string, unknown>; id?: string } = {}): Promise<void> {
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
      this.title = title;
      document.title = title && title !== 'BrowserBox' ? `${title} — BrowserBox` : 'BrowserBox';
    },
    focus: () => focus(),
    close: () => close(),
    onClose: (fn) => void closers.push(fn),
    // The address follows what the app shows, so a reload or a copied link opens the same thing.
    setArgs: (next) => {
      if (!opts.id) return;
      void import('@/app/app-tab').then(({ appTabUrl }) => history.replaceState(null, '', appTabUrl(opts.id!, next)));
    },
  };
  // The kernel (or the agent) asked for an app: hand it to the desktop, or offer to start one.
  // Pages that host apps themselves (the agent window's workbench) handle `app:open` on their own.
  if (!opts.embedsApps)
    os.bus.on('app:open', ({ id, args }) => {
      if (!desktopOpen(os)) offer('The agent wants to show you something', `Open ${id} in the desktop`, { label: 'Open desktop', run: () => openInDesktop(os, id, args) });
    });
  const ctx: AppContext = { os, win, root, args: opts.args ?? Object.fromEntries(new URLSearchParams(location.search)), proc, launch: (id, args) => openInDesktop(os, id, args), on: (type, fn) => os.bus.on(type, fn) };
  root.dataset.app = name.toLowerCase();
  root.replaceChildren(); // drop the boot placeholder painted by the HTML
  const cleanup = await app.mount(ctx);
  if (typeof cleanup === 'function') closers.push(cleanup);
  addEventListener('pagehide', () => closers.splice(0).forEach((fn) => fn()));
}
