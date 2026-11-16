import type { Kernel } from '@/kernel/kernel';
import { APPS, AppHost, type AppManifest } from './apps';
import { permissionDialog } from './dialog';
import { h } from './dom';
import { WindowManager } from './wm';

/** Builds the desktop: wallpaper, icons, windows, taskbar, launcher, toasts. */
export function createDesktop(os: Kernel, mountPoint: HTMLElement): AppHost {
  const area = h('main', { class: 'desk-area' });
  const wm = new WindowManager(area);
  const apps = new AppHost(os, wm);
  const visible = APPS.filter((a) => !a.hidden);

  const tile = (a: AppManifest) => h('span', { class: 'tile', style: `background:${a.color}` }, a.icon);

  // Desktop icons
  const icons = h(
    'div',
    { class: 'desk-icons' },
    visible.map((a) => h('button', { class: 'desk-icon', title: `Open ${a.name}`, ondblclick: () => void apps.launch(a.id), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void apps.launch(a.id) }, tile(a), h('span', null, a.name))),
  );
  // Single tap opens on touch devices, where double-click is awkward.
  icons.addEventListener('click', (e) => {
    if (!matchMedia('(pointer: coarse)').matches) return;
    const btn = (e.target as HTMLElement).closest('.desk-icon');
    const i = btn ? [...icons.children].indexOf(btn) : -1;
    if (i >= 0) void apps.launch(visible[i]!.id);
  });
  area.append(icons);

  // Launcher
  const search = h('input', { class: 'input', placeholder: 'Search apps…', 'aria-label': 'Search apps' });
  const grid = h('div', { class: 'launcher-grid' });
  const launcher = h('div', { class: 'launcher', hidden: true }, search, grid);
  const renderGrid = () => {
    const q = search.value.trim().toLowerCase();
    grid.replaceChildren(
      ...visible
        .filter((a) => a.name.toLowerCase().includes(q))
        .map((a) =>
          h(
            'button',
            {
              class: 'launcher-item',
              onclick: () => {
                toggleLauncher(false);
                void apps.launch(a.id);
              },
            },
            tile(a),
            h('span', null, a.name),
          ),
        ),
    );
  };
  const toggleLauncher = (show = launcher.hidden) => {
    launcher.hidden = !show;
    if (show) {
      search.value = '';
      renderGrid();
      search.focus();
    }
  };
  search.addEventListener('input', renderGrid);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (grid.firstElementChild as HTMLElement | null)?.click();
    if (e.key === 'Escape') toggleLauncher(false);
  });
  addEventListener('pointerdown', (e) => {
    if (!launcher.hidden && !(e.target as HTMLElement).closest('.launcher, .start')) toggleLauncher(false);
  });
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleLauncher();
    }
  });

  // Taskbar
  const tasks = h('div', { class: 'tasks', role: 'tablist' });
  const clock = h('time', { class: 'clock' });
  const procCount = h('button', { class: 'tray-btn', title: 'Processes — open Task Manager', onclick: () => void apps.launch('taskmgr') });
  const bar = h(
    'footer',
    { class: 'taskbar' },
    h('button', { class: 'start', title: 'Apps (Ctrl+K)', 'aria-label': 'Open launcher', onclick: () => toggleLauncher() }, '◆'),
    tasks,
    h('div', { class: 'tray' }, procCount, clock),
  );
  const renderTasks = () => {
    tasks.replaceChildren(
      ...wm.windows().map((w) =>
        h(
          'button',
          {
            class: `task ${wm.focused === w ? 'active' : ''}`,
            role: 'tab',
            title: w.title,
            onclick: () => (wm.focused === w && !w.minimized ? w.minimize() : w.focus()),
            onauxclick: (e: MouseEvent) => e.button === 1 && w.close(),
          },
          h('span', { class: 'task-icon' }, w.icon),
          h('span', { class: 'task-title' }, w.title),
        ),
      ),
    );
  };
  wm.onChange(renderTasks);
  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 15000);
  const renderProcs = () => {
    const list = os.procs.list();
    const busy = list.filter((p) => p.state === 'running' && p.kind !== 'service').length;
    procCount.textContent = `${busy ? '● ' : ''}${list.length} proc`;
    procCount.classList.toggle('busy', busy > 0);
  };
  os.bus.on('proc:spawn', renderProcs);
  os.bus.on('proc:exit', renderProcs);
  os.bus.on('proc:update', renderProcs);
  renderProcs();

  // Toasts
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  os.bus.on('notify', (n) => {
    const t = h('div', { class: `toast ${n.level ?? 'info'}` }, h('strong', null, n.title), n.body ? h('span', null, n.body) : null);
    toasts.append(t);
    setTimeout(() => t.remove(), n.level === 'error' ? 8000 : 4500);
  });

  os.perms.setPrompter(permissionDialog);
  mountPoint.replaceChildren(area, launcher, bar, toasts);
  return apps;
}
