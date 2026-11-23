import type { Stat } from '@/client/index';
import { iconFor } from '@/apps/files/filetypes';
import { APPS, type AppManifest } from '../apps';
import { h } from '../dom';
import { icon, mark } from '../icons';
import { openMenu, openMenuAt, type MenuEntry } from '../menu';
import { calendar, clockText, deletePath, DESKTOP_DIR, importFiles, newFolder, newTextFile, openPath, renamePath, type ShellContext } from './shared';

type Item = { kind: 'app'; app: AppManifest } | { kind: 'file'; stat: Stat };

/**
 * The wide-screen shell: wallpaper, desktop icons (apps and the files in
 * ~/Desktop), right-click menus, a taskbar with launcher, notifications and
 * a calendar, and window snapping (in the window manager).
 */
export function mountDesk(c: ShellContext): () => void {
  const { os, wm, apps, area, mount } = c;
  const offs: Array<() => void> = [];
  const visible = APPS.filter((a) => !a.hidden);
  const show = () => os.settings.get<boolean>('desktop.icons', true);
  const sortBy = () => os.settings.get<'name' | 'kind'>('desktop.sort', 'name');

  // ---- desktop icons ----------------------------------------------------------
  const icons = h('div', { class: 'desk-icons', role: 'list', 'aria-label': 'Desktop' });
  let files: Stat[] = [];
  let items: Item[] = [];
  let selected: HTMLElement | null = null;
  const select = (el: HTMLElement | null) => {
    selected?.classList.remove('sel');
    selected = el;
    el?.classList.add('sel');
  };
  const open = (it: Item) => (it.kind === 'app' ? void apps.launch(it.app.id) : openPath(apps, it.stat.path, it.stat.kind === 'dir'));
  const render = () => {
    icons.hidden = !show();
    const sorted = [...files].sort((a, b) => (sortBy() === 'kind' ? Number(b.kind === 'dir') - Number(a.kind === 'dir') : 0) || a.name.localeCompare(b.name));
    items = [...visible.map((app) => ({ kind: 'app' as const, app })), ...sorted.map((stat) => ({ kind: 'file' as const, stat }))];
    select(null);
    icons.replaceChildren(
      ...items.map((it, i) => {
        const name = it.kind === 'app' ? it.app.name : it.stat.name;
        const ic = it.kind === 'app' ? it.app.icon : iconFor(it.stat.name, it.stat.kind === 'dir');
        return h(
          'button',
          { class: `desk-icon${it.kind === 'file' ? ' file' : ''}`, role: 'listitem', title: it.kind === 'app' ? `Open ${name}` : it.stat.path, dataset: { i: String(i) }, ondblclick: () => open(it), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && open(it) },
          h('span', { class: 'tile' }, icon(ic, 22)),
          h('span', { class: 'desk-label' }, name),
        );
      }),
    );
  };
  const loadFiles = async () => {
    // Only create it when missing: creating it is itself a change, which would reload again.
    if (!(await os.fs.exists(DESKTOP_DIR))) await os.fs.mkdir(DESKTOP_DIR).catch(() => undefined);
    files = await os.fs.readdir(DESKTOP_DIR).catch(() => []);
    render();
  };
  const itemOf = (el: Element | null) => {
    const b = el?.closest<HTMLElement>('.desk-icon');
    return b ? { el: b, it: items[Number(b.dataset.i)]! } : null;
  };
  icons.addEventListener('click', (e) => {
    const hit = itemOf(e.target as Element);
    if (!hit) return;
    // A single tap opens on touch screens, where double-click is awkward.
    if (matchMedia('(pointer: coarse)').matches) open(hit.it);
    else select(hit.el);
  });
  offs.push(os.bus.on('fs:change', ({ path }) => (path === DESKTOP_DIR || path.startsWith(`${DESKTOP_DIR}/`)) && void loadFiles()));
  offs.push(os.bus.on('settings:change', ({ key }) => (key === 'desktop.icons' || key === 'desktop.sort') && render()));

  // ---- right-click menus ----------------------------------------------------------
  const iconMenu = (it: Item): MenuEntry[] => {
    if (it.kind === 'app') return [{ label: 'Open', icon: it.app.icon, onSelect: () => open(it) }, ...(it.app.external ? [{ label: 'Open in new tab', icon: 'external' as const, onSelect: () => void apps.launch(it.app.id, { newTab: true }) }] : [])];
    const p = it.stat.path;
    const dir = it.stat.kind === 'dir';
    return [
      { label: 'Open', icon: dir ? 'folder' : 'file', onSelect: () => open(it) },
      ...(!dir ? [{ label: 'Open in Editor', icon: 'edit' as const, onSelect: () => void apps.launch('editor', { path: p }) }, { label: 'Preview', icon: 'eye' as const, onSelect: () => void apps.launch('preview', { path: p }) }] : [{ label: 'Open Terminal here', icon: 'terminal' as const, onSelect: () => void apps.launch('terminal', { cwd: p }) }]),
      { label: 'Show in Files', icon: 'folder', onSelect: () => void apps.launch('files', { path: DESKTOP_DIR }) },
      { separator: true },
      { label: 'Rename…', icon: 'edit', onSelect: () => void renamePath(os, p) },
      { label: 'Copy path', icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(p) },
      { label: 'Delete', icon: 'trash', onSelect: () => void deletePath(os, p) },
    ];
  };
  const deskMenu = (): MenuEntry[] => [
    { label: 'New folder', icon: 'folderPlus', onSelect: () => void newFolder(os) },
    { label: 'New text file', icon: 'filePlus', onSelect: () => void newTextFile(os, apps) },
    { separator: true },
    { label: 'Open Terminal here', icon: 'terminal', onSelect: () => void apps.launch('terminal', { cwd: DESKTOP_DIR }) },
    { label: 'Open in Files', icon: 'folder', onSelect: () => void apps.launch('files', { path: DESKTOP_DIR }) },
    { separator: true },
    { group: 'Sort by' },
    { label: 'Name', icon: 'sort', checked: sortBy() === 'name', onSelect: () => os.settings.set('desktop.sort', 'name') },
    { label: 'Kind (folders first)', icon: 'sort', checked: sortBy() === 'kind', onSelect: () => os.settings.set('desktop.sort', 'kind') },
    { separator: true },
    { label: show() ? 'Hide desktop icons' : 'Show desktop icons', icon: 'grid', onSelect: () => os.settings.set('desktop.icons', !show()) },
    { label: 'Change wallpaper…', icon: 'image', onSelect: () => void apps.launch('settings', { section: 'appearance' }) },
    { label: 'Refresh', icon: 'refresh', onSelect: () => void loadFiles() },
    { separator: true },
    { label: 'Task Manager', icon: 'activity', onSelect: () => void apps.launch('taskmgr') },
    { label: 'Settings', icon: 'gear', onSelect: () => void apps.launch('settings') },
  ];
  const onContext = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.win, .taskbar, .launcher, input, textarea')) return;
    e.preventDefault();
    const hit = itemOf(target);
    if (hit) select(hit.el);
    openMenuAt(e.clientX, e.clientY, hit ? iconMenu(hit.it) : deskMenu(), hit ? (hit.it.kind === 'app' ? hit.it.app.name : hit.it.stat.name) : 'Desktop');
  };
  area.addEventListener('contextmenu', onContext);
  const clearSel = (e: PointerEvent) => !(e.target as HTMLElement).closest('.desk-icon, .menu') && select(null);
  area.addEventListener('pointerdown', clearSel);

  // Files dragged in from the computer land on the desktop.
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files') || (e.target as HTMLElement).closest('.win')) return;
    e.preventDefault();
    area.classList.add('drop');
  };
  const onDragLeave = () => area.classList.remove('drop');
  const onDrop = (e: DragEvent) => {
    area.classList.remove('drop');
    if (!e.dataTransfer?.files.length || (e.target as HTMLElement).closest('.win')) return;
    e.preventDefault();
    void importFiles(os, e.dataTransfer.files);
  };
  area.addEventListener('dragover', onDragOver);
  area.addEventListener('dragleave', onDragLeave);
  area.addEventListener('drop', onDrop);
  area.prepend(icons);

  // ---- launcher ---------------------------------------------------------------
  const search = h('input', { class: 'input', placeholder: 'Search apps…', 'aria-label': 'Search apps' });
  const grid = h('div', { class: 'launcher-grid' });
  const launcher = h('div', { class: 'launcher', hidden: true }, search, grid);
  const renderGrid = () => {
    const q = search.value.trim().toLowerCase();
    grid.replaceChildren(...visible.filter((a) => a.name.toLowerCase().includes(q)).map((a) => h('button', { class: 'launcher-item', onclick: () => (toggleLauncher(false), void apps.launch(a.id)) }, h('span', { class: 'tile' }, icon(a.icon, 22)), h('span', null, a.name))));
  };
  const toggleLauncher = (on = launcher.hidden) => {
    launcher.hidden = !on;
    if (on) {
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
  const outside = (e: PointerEvent) => !launcher.hidden && !(e.target as HTMLElement).closest('.launcher, .start') && toggleLauncher(false);
  const keys = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleLauncher();
    }
  };
  addEventListener('pointerdown', outside);
  addEventListener('keydown', keys);

  // ---- taskbar -----------------------------------------------------------------
  const tasks = h('div', { class: 'tasks', role: 'tablist' });
  const clock = h('button', { class: 'tray-btn clock', type: 'button', title: 'Calendar', onclick: () => openMenu(clock, [{ element: calendar() }], 'Calendar') });
  const badge = h('span', { class: 'tray-badge', hidden: true });
  const bell = h('button', { class: 'tray-btn tray-icon', type: 'button', title: 'Notifications', 'aria-label': 'Notifications', onclick: () => (c.notices.read(), openMenu(bell, [{ element: c.notices.panel() }], 'Notifications')) }, icon('bell', 17), badge);
  const procCount = h('button', { class: 'tray-btn', type: 'button', title: 'Processes — open Task Manager', onclick: () => void apps.launch('taskmgr') });
  const showDesk = h('button', { class: 'show-desk', type: 'button', title: 'Show desktop', 'aria-label': 'Show desktop', onclick: () => wm.minimizeAll() });
  const bar = h(
    'footer',
    { class: 'taskbar' },
    h('button', { class: 'start', title: 'Apps (Ctrl+K)', 'aria-label': 'Open launcher', onclick: () => toggleLauncher() }, mark(20)),
    tasks,
    h('div', { class: 'tray' }, procCount, bell, clock),
    showDesk,
  );
  const renderTasks = () =>
    tasks.replaceChildren(
      ...wm.windows().map((w) =>
        h(
          'button',
          {
            class: `task ${wm.focused === w ? 'active' : ''}${w.minimized ? ' min' : ''}`,
            role: 'tab',
            title: w.title,
            onclick: () => (wm.focused === w && !w.minimized ? w.minimize() : w.focus()),
            onauxclick: (e: MouseEvent) => e.button === 1 && w.close(),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              openMenuAt(e.clientX, e.clientY, [
                { label: w.minimized ? 'Restore' : 'Minimize', icon: 'minus', onSelect: () => (w.minimized ? w.focus() : w.minimize()) },
                { label: 'Maximize / restore', icon: 'square', onSelect: () => (w.focus(), w.toggleMaximize()) },
                { separator: true },
                { label: 'Close window', icon: 'close', onSelect: () => w.close() },
              ], w.title);
            },
          },
          h('span', { class: 'task-icon' }, icon(w.icon, 15)),
          h('span', { class: 'task-title' }, w.title),
        ),
      ),
    );
  bar.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.task')) return;
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY, [
      { label: 'Task Manager', icon: 'activity', onSelect: () => void apps.launch('taskmgr') },
      { label: 'Show desktop', icon: 'home', onSelect: () => wm.minimizeAll() },
      { label: 'Settings', icon: 'gear', onSelect: () => void apps.launch('settings') },
    ], 'Taskbar');
  });
  offs.push(wm.onChange(renderTasks));
  const renderBadge = () => {
    badge.hidden = !c.notices.unread;
    badge.textContent = String(Math.min(99, c.notices.unread));
  };
  offs.push(c.notices.onChange(renderBadge));
  const tick = () => (clock.textContent = clockText());
  const timer = setInterval(tick, 15000);
  const renderProcs = () => {
    const list = os.procs.list();
    const busy = list.filter((p) => p.state === 'running' && p.kind !== 'service').length;
    procCount.textContent = `${busy ? '● ' : ''}${list.length} proc`;
    procCount.classList.toggle('busy', busy > 0);
  };
  offs.push(os.bus.on('proc:spawn', renderProcs), os.bus.on('proc:exit', renderProcs), os.bus.on('proc:update', renderProcs));

  mount.replaceChildren(c.wall, area, launcher, bar, c.toasts);
  tick();
  renderTasks();
  renderBadge();
  renderProcs();
  void loadFiles();

  return () => {
    offs.forEach((f) => f());
    clearInterval(timer);
    removeEventListener('pointerdown', outside);
    removeEventListener('keydown', keys);
    area.removeEventListener('contextmenu', onContext);
    area.removeEventListener('pointerdown', clearSel);
    area.removeEventListener('dragover', onDragOver);
    area.removeEventListener('dragleave', onDragLeave);
    area.removeEventListener('drop', onDrop);
    icons.remove();
  };
}
