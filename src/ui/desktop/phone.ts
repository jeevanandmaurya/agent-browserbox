import { APPS, type AppManifest } from '../apps';
import { h } from '../dom';
import { icon } from '../icons';
import { openMenu, openMenuAt } from '../menu';
import type { WindowHandle } from '../wm';
import type { ShellContext } from './shared';

/** Apps in the dock, in order, when they exist. */
const DOCK = ['agent', 'terminal', 'files', 'browser'];
const HOLD_MS = 450;

/**
 * The phone shell, built like iOS and Android home screens: a status bar, a
 * home screen with a clock, an app grid, a search pill and a dock; apps fill
 * the screen. The home bar at the bottom goes home on a tap or a short swipe
 * up, and shows recent apps on a long swipe or a long press. The browser's
 * back button (Android) also goes home.
 */
export function mountPhone(c: ShellContext): () => void {
  const { os, wm, apps, area, mount } = c;
  const offs: Array<() => void> = [];
  const visible = APPS.filter((a) => !a.hidden);
  const dockApps = DOCK.map((id) => visible.find((a) => a.id === id)).filter((a): a is AppManifest => !!a);
  const gridApps = visible.filter((a) => !dockApps.includes(a));

  // ---- status bar ----------------------------------------------------------------
  const time = h('span', { class: 'sb-time' });
  const busyDot = h('span', { class: 'sb-busy', hidden: true, title: 'Working' });
  const net = h('span', { class: 'sb-net' });
  const battery = h('span', { class: 'sb-batt', hidden: true });
  const statusBar = h('button', { class: 'phone-status', type: 'button', 'aria-label': 'Quick settings and notifications', onclick: () => quickPanel() }, time, h('span', { class: 'sb-right' }, busyDot, net, battery));
  const tick = () => {
    // Phone clocks read 4:16, without AM/PM.
    const short = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).formatToParts().filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
    time.textContent = short;
    clockBig.textContent = short;
    dateLine.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  };
  const renderNet = () => (net.textContent = navigator.onLine ? '' : 'Offline');
  addEventListener('online', renderNet);
  addEventListener('offline', renderNet);
  type Battery = { level: number; charging: boolean; addEventListener(t: string, f: () => void): void };
  void (navigator as unknown as { getBattery?: () => Promise<Battery> }).getBattery?.().then((b) => {
    const draw = () => {
      battery.hidden = false;
      battery.textContent = `${Math.round(b.level * 100)}%${b.charging ? ' ⚡' : ''}`;
    };
    b.addEventListener('levelchange', draw);
    b.addEventListener('chargingchange', draw);
    draw();
  });
  const renderBusy = () => (busyDot.hidden = !os.procs.list().some((p) => p.state === 'running' && (p.kind === 'agent' || p.kind === 'sandbox')));
  offs.push(os.bus.on('proc:update', renderBusy), os.bus.on('proc:exit', renderBusy));

  // ---- home screen -------------------------------------------------------------
  const clockBig = h('strong', { class: 'home-clock' });
  const dateLine = h('span', { class: 'home-date' });
  const appIcon = (a: AppManifest, label = true) =>
    h('button', { class: 'home-app', type: 'button', 'aria-label': a.name, dataset: { id: a.id }, onclick: () => launch(a.id) }, h('span', { class: 'home-tile' }, icon(a.icon, 26)), label ? h('span', { class: 'home-label' }, a.name) : null);
  const search = h('button', { class: 'home-search', type: 'button', onclick: () => searchSheet() }, icon('search', 16), h('span', null, 'Search'));
  const home = h(
    'section',
    { class: 'phone-home', 'aria-label': 'Home screen' },
    h('div', { class: 'home-widget' }, clockBig, dateLine),
    h('div', { class: 'home-grid' }, gridApps.map((a) => appIcon(a))),
    h('div', { class: 'home-bottom' }, search, h('nav', { class: 'home-dock', 'aria-label': 'Dock' }, dockApps.map((a) => appIcon(a, false)))),
  );
  const launch = (id: string, args?: Record<string, unknown>) => void apps.launch(id, args);

  // Long press (or right-click) on the home screen: wallpaper and settings; on an app: open it.
  let holdTimer = 0;
  const homeMenu = (x: number, y: number, target: HTMLElement) => {
    const appBtn = target.closest<HTMLElement>('.home-app');
    const a = appBtn && visible.find((v) => v.id === appBtn.dataset.id);
    if (a) return openMenuAt(x, y, [{ label: `Open ${a.name}`, icon: a.icon, hint: a.external ? 'Opens in its own tab' : undefined, onSelect: () => launch(a.id) }, { label: 'Task Manager', icon: 'activity', onSelect: () => launch('taskmgr') }], a.name);
    openMenuAt(x, y, [
      { label: 'Change wallpaper', icon: 'image', onSelect: () => launch('settings', { section: 'appearance' }) },
      { label: 'Settings', icon: 'gear', onSelect: () => launch('settings') },
      { label: 'Use the desktop layout', hint: 'Turn the phone sideways or use a wider screen', icon: 'grid', onSelect: () => os.notify({ title: 'The desktop layout is used on screens wider than 640px' }) },
    ], 'Home screen');
  };
  home.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    clearTimeout(holdTimer);
    homeMenu(e.clientX, e.clientY, e.target as HTMLElement);
  });
  home.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const { clientX: x, clientY: y } = e;
    const target = e.target as HTMLElement;
    holdTimer = window.setTimeout(() => homeMenu(x, y, target), HOLD_MS + 150);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointermove'] as const) home.addEventListener(ev, () => clearTimeout(holdTimer));

  // ---- search ---------------------------------------------------------------------
  function searchSheet(): void {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Search apps', 'aria-label': 'Search apps', enterkeyhint: 'go' });
    const list = h('div', { class: 'phone-results' });
    const render = () => {
      const q = input.value.trim().toLowerCase();
      list.replaceChildren(...visible.filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q)).map((a) => h('button', { class: 'pop-item', type: 'button', onclick: () => (closeMenus(), launch(a.id)) }, icon(a.icon, 18), h('span', { class: 'menu-text' }, h('span', null, a.name)))));
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (list.firstElementChild as HTMLElement | null)?.click());
    render();
    openMenu(search, [{ element: h('div', { class: 'phone-search' }, input, list) }], 'Search');
    setTimeout(() => input.focus(), 50);
  }
  const closeMenus = () => document.querySelector<HTMLElement>('.menu-scrim')?.dispatchEvent(new PointerEvent('pointerdown'));

  // ---- quick settings and notifications -------------------------------------------------
  function quickPanel(): void {
    c.notices.read();
    const theme = os.settings.get<string>('ui.theme', 'system');
    const seg = h(
      'div',
      { class: 'qs-seg', role: 'radiogroup', 'aria-label': 'Theme' },
      (['light', 'dark', 'system'] as const).map((t) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(theme === t), onclick: () => (os.settings.set('ui.theme', t), closeMenus()) }, t === 'system' ? 'Auto' : t[0]!.toUpperCase() + t.slice(1))),
    );
    const tile = (label: string, ic: Parameters<typeof icon>[0], fn: () => void) => h('button', { class: 'qs-tile', type: 'button', onclick: () => (closeMenus(), fn()) }, icon(ic, 20), h('span', null, label));
    const panel = h(
      'div',
      { class: 'qs' },
      h('div', { class: 'qs-tiles' }, tile('Wallpaper', 'image', () => launch('settings', { section: 'appearance' })), tile('Processes', 'activity', () => launch('taskmgr')), tile('Settings', 'gear', () => launch('settings')), tile('Recents', 'grid', () => recents(true))),
      seg,
      c.notices.panel(),
    );
    openMenu(statusBar, [{ element: panel }], 'Quick settings');
  }

  // ---- going home, recent apps and the home bar ---------------------------------------------
  const topWindow = (): WindowHandle | null => (wm.focused && !wm.focused.minimized ? wm.focused : null);
  const goHome = () => {
    recents(false);
    wm.minimizeAll();
  };
  let switching = false;
  function recents(on: boolean): void {
    switching = on;
    area.classList.toggle('switching', on);
    switcherBar.hidden = !on;
    if (!on) {
      for (const w of wm.windows()) w.el.style.removeProperty('--i');
      return;
    }
    const order = [...wm.windows()].sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex));
    order.forEach((w, i) => w.el.style.setProperty('--i', String(i)));
    area.scrollLeft = 0;
    empty.hidden = order.length > 0;
  }
  const empty = h('p', { class: 'switcher-empty' }, 'No recent apps');
  const switcherBar = h('div', { class: 'switcher-bar', hidden: true }, empty, h('button', { class: 'btn', type: 'button', onclick: () => (wm.windows().slice().forEach((w) => w.close()), goHome()) }, 'Close all'));
  // In recents: tap a card to open it, swipe it up to close it, tap the background to go home.
  const onAreaDown = (e: PointerEvent) => {
    if (!switching) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>('.win');
    if (!card) return goHome();
    const win = wm.windows().find((w) => w.el === card);
    if (!win) return;
    e.preventDefault();
    const y0 = e.clientY;
    const x0 = e.clientX;
    let dy = 0;
    let dx = 0;
    const move = (ev: PointerEvent) => {
      dy = Math.min(0, ev.clientY - y0);
      dx = ev.clientX - x0;
      if (Math.abs(dy) > Math.abs(dx)) card.style.translate = `0 ${dy}px`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      card.style.translate = '';
      if (dy < -90) {
        win.close();
        recents(wm.windows().length > 0);
        if (!wm.windows().length) goHome();
      } else if (Math.abs(dy) < 8 && Math.abs(dx) < 8) {
        recents(false);
        win.focus();
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };
  area.addEventListener('pointerdown', onAreaDown, true);

  const pill = h('div', { class: 'home-bar', role: 'button', tabindex: 0, 'aria-label': 'Home. Swipe up and hold, or long press, for recent apps' }, h('i'));
  pill.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), goHome()));
  pill.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      pill.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const y0 = e.clientY;
    const t0 = performance.now();
    const win = topWindow();
    let dy = 0;
    let held = false;
    const hold = window.setTimeout(() => {
      held = true;
      if (win) win.el.style.transform = '';
      recents(true);
    }, HOLD_MS);
    const move = (ev: PointerEvent) => {
      dy = Math.min(0, ev.clientY - y0);
      if (Math.abs(dy) > 10 && !held) {
        clearTimeout(hold);
        // The app shrinks with the finger, as on a phone.
        const p = Math.min(1, -dy / (innerHeight * 0.5));
        if (win) win.el.style.transform = `translateY(${dy * 0.6}px) scale(${1 - p * 0.35})`;
      }
    };
    const up = () => {
      clearTimeout(hold);
      pill.removeEventListener('pointermove', move);
      pill.removeEventListener('pointerup', up);
      pill.removeEventListener('pointercancel', up);
      if (win) win.el.style.transform = '';
      if (held) return;
      const long = -dy > innerHeight * 0.28 && performance.now() - t0 > 250;
      if (long) recents(true);
      else if (switching) recents(false);
      else goHome();
    };
    pill.addEventListener('pointermove', move);
    pill.addEventListener('pointerup', up);
    pill.addEventListener('pointercancel', up);
  });

  // Android's back button goes home instead of leaving BrowserBox.
  const onPop = () => {
    if (switching) recents(false);
    else if (topWindow()) goHome();
    else return;
    history.pushState({ bbx: 'phone' }, '');
  };
  history.pushState({ bbx: 'phone' }, '');
  addEventListener('popstate', onPop);

  const sync = () => {
    const appOpen = !!topWindow();
    mount.classList.toggle('app-open', appOpen || switching);
    if (switching) recents(true); // windows came or went while in recents
  };
  offs.push(wm.onChange(sync));

  mount.replaceChildren(c.wall, home, area, statusBar, switcherBar, pill, c.toasts);
  tick();
  renderNet();
  renderBusy();
  sync();
  const timer = setInterval(tick, 15000);
  return () => {
    recents(false);
    offs.forEach((f) => f());
    clearInterval(timer);
    removeEventListener('online', renderNet);
    removeEventListener('offline', renderNet);
    removeEventListener('popstate', onPop);
    area.removeEventListener('pointerdown', onAreaDown, true);
    mount.classList.remove('app-open');
  };
}
