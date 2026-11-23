import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { AppHost } from '../apps';
import { permissionDialog } from '../dialog';
import { h } from '../dom';
import { applyWallpaper } from '../wallpaper';
import { WindowManager } from '../wm';
import { mountDesk } from './desk';
import { mountPhone } from './phone';
import { Notices, type ShellContext } from './shared';
import './desktop.css';

/** Phones get a home screen; anything wider gets the desktop. */
const PHONE = '(max-width: 640px)';

/**
 * The desktop GUI. One window manager and set of apps, shown through one of
 * two shells: a desktop (wide screens) or a phone home screen. Turning a
 * tablet or resizing a window switches shells without closing any app.
 */
export function createDesktop(os: Kernel, mount: HTMLElement): AppHost {
  const area = h('main', { class: 'desk-area' });
  const wall = h('div', { class: 'wallpaper', 'aria-hidden': 'true' });
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  applyWallpaper(os, wall);
  const wm = new WindowManager(area);
  const apps = new AppHost(os, wm);
  const c: ShellContext = { os, wm, apps, area, wall, toasts, notices: new Notices(os, toasts), mount };

  os.perms.setPrompter(permissionDialog);
  const query = matchMedia(PHONE);
  let teardown = () => {};
  const build = () => {
    teardown();
    const phone = query.matches;
    document.documentElement.dataset.shell = phone ? 'phone' : 'desktop';
    mount.className = phone ? 'shell-phone' : 'shell-desk';
    // On phones every app fills the screen.
    for (const w of wm.windows()) w.el.classList.toggle('max', phone);
    teardown = phone ? mountPhone(c) : mountDesk(c);
  };
  query.addEventListener('change', build);
  build();
  if (!(os as { shared?: boolean }).shared) os.notify({ title: 'Running a private kernel', body: 'This browser has no SharedWorker, so each window has its own kernel. Files and settings are still shared.', level: 'warn' });
  return apps;
}
