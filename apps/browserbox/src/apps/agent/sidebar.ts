import { setWaitingBadge } from '@/app/launch';
import { agentsOf } from '@/app/agents';
import { deleteSession, listSessions, loadProjects, PROJECTS_KEY, type SessionInfo } from '@jeevanand/agent-browserbox/ui';
import { currentProject } from '@/app/project';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { getProfile } from '@jeevanand/agent-browserbox-runtime/client';
import { PROFILE } from '@/app/boot';
import { fmtTime, h } from '@/ui/dom';
import { openMenu } from '@/ui/menu';
import { avatar, chooseProfile, signOut } from '@/ui/profiles';
import { icon } from './icons';

export interface SidebarActions {
  newChat(): void;
  openChat(id: string): void;
  settings(): void;
  /** Settings → Profile. */
  profileSettings(): void;
  /** Projects: switch to one, make one, or open the current one's settings. */
  switchProject(id: string): void;
  newProject(): void;
  projectSettings(): void;
  processes(): void;
  openDesktop(): void;
  /** Inside the desktop: the button offers a tab of its own instead. */
  embedded?: boolean;
  collapse(): void;
}

export interface Sidebar {
  el: HTMLElement;
  /** Re-reads the saved chats; `active` is the current session id. */
  refresh(active?: string): Promise<void>;
  focusFirst(): void;
}

/** Groups chats the way people scan them: today, this week, older. */
function bucket(ts: number): string {
  const day = 86_400_000;
  const start = new Date().setHours(0, 0, 0, 0);
  if (ts >= start) return 'Today';
  if (ts >= start - 6 * day) return 'Previous 7 days';
  return 'Older';
}

export function createSidebar(os: Kernel, act: SidebarActions): Sidebar {
  // Who is using BrowserBox: the profile, with switching and signing out.
  const profileName = h('span', { class: 'sb-kernel-text' }, '');
  const profileAvatar = h('span', { class: 'sb-avatar' });
  const profileBtn = h(
    'button',
    {
      class: 'sb-row sb-profile',
      type: 'button',
      title: 'Profile',
      'aria-haspopup': 'menu',
      onclick: async () => {
        const locked = (await os.secrets.status().catch(() => 'open')) !== 'open';
        openMenu(
          profileBtn,
          [
            { label: 'Switch profile…', onSelect: () => void chooseProfile() },
            { label: 'Profile settings…', onSelect: act.profileSettings },
            ...(locked ? [{ separator: true as const }, { label: 'Sign out', onSelect: () => void signOut(os) }] : []),
          ],
          'Profile',
        );
      },
    },
    profileAvatar,
    profileName,
  );
  const showProfile = async () => {
    const p = await getProfile(await PROFILE).catch(() => null);
    profileName.textContent = p?.name ?? 'Profile';
    profileAvatar.replaceChildren(avatar(p?.name ?? '?', 22));
  };
  void showProfile();
  os.bus.on('settings:change', () => void showProfile());
  // The project picker: which workspace these chats belong to.
  const projectName = h('span', { class: 'sb-project-name' });
  const projectBtn = h(
    'button',
    {
      class: 'sb-row sb-project',
      type: 'button',
      title: 'Project',
      'aria-haspopup': 'menu',
      onclick: () => {
        const here = currentProject(os).id;
        openMenu(
          projectBtn,
          [
            { group: 'Projects' },
            ...loadProjects(os).map((p) => ({ label: p.name, hint: p.folder.replace(/^\/home\/user\//, '~/'), checked: p.id === here, onSelect: () => act.switchProject(p.id) })),
            { separator: true as const },
            { label: 'New project…', onSelect: act.newProject },
            { label: 'Project settings…', onSelect: act.projectSettings },
          ],
          'Projects',
        );
      },
    },
    icon('folder', 18),
    projectName,
    icon('chevron', 14),
  );
  const showProject = () => {
    projectName.textContent = currentProject(os).name;
  };
  showProject();
  os.bus.on('settings:change', ({ key }) => key === PROJECTS_KEY && showProject());
  let all: SessionInfo[] = [];
  let active = '';
  /** Chats running in the kernel right now: working, or waiting for you (an approval or a question). */
  let live = new Map<string, 'running' | 'waiting'>();
  const search = h('input', { class: 'sb-search', type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats' });
  const list = h('nav', { class: 'sb-list', 'aria-label': 'Recent chats' });
  const kernelLabel = h('span', { class: 'sb-kernel-text' }, 'Kernel');
  const dot = h('span', { class: 'sb-dot', 'aria-hidden': 'true' });

  const row = (label: string, ic: Parameters<typeof icon>[0], onclick: () => void, extra: Record<string, unknown> = {}) =>
    h('button', { class: 'sb-row', type: 'button', onclick, ...extra }, icon(ic, 18), h('span', null, label));

  const el = h(
    'aside',
    { class: 'sb', 'aria-label': 'Chats' },
    h(
      'div',
      { class: 'sb-top' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('cube', 16)), h('span', { class: 'brand-name' }, 'BrowserBox')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Close sidebar', 'aria-label': 'Close sidebar', onclick: act.collapse }, icon('sidebar', 18)),
    ),
    projectBtn,
    row('New chat', 'plus', act.newChat, { class: 'sb-row sb-new' }),
    h('label', { class: 'sb-search-wrap' }, icon('search', 16), search),
    h('div', { class: 'sb-scroll' }, list),
    h(
      'div',
      { class: 'sb-foot' },
      profileBtn,
      row('Settings', 'gear', act.settings),
      h('button', { class: 'sb-row sb-kernel', type: 'button', title: 'Show processes', onclick: act.processes }, icon('chip', 18), kernelLabel, dot),
      h('button', { class: 'sb-desktop', type: 'button', title: act.embedded ? 'Open the agent in a browser tab of its own' : 'Open the optional desktop in a new window', onclick: act.openDesktop }, act.embedded ? 'Open in new tab' : 'Open desktop', icon('external', 13)),
    ),
  );

  function render(): void {
    const q = search.value.trim().toLowerCase();
    const shown = q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
    const out: HTMLElement[] = [];
    let group = '';
    for (const s of shown) {
      const g = bucket(s.updated);
      if (g !== group) out.push(h('div', { class: 'sb-group' }, (group = g)));
      out.push(
        h(
          'div',
          { class: `sb-chat ${s.id === active ? 'active' : ''}` },
          h(
            'button',
            { class: 'sb-chat-open', type: 'button', title: `${s.title}\n${fmtTime(s.updated)}`, 'aria-current': s.id === active ? 'page' : 'false', onclick: () => act.openChat(s.id) },
            live.has(s.id) ? h('span', { class: `sb-live ${live.get(s.id)}`, title: live.get(s.id) === 'waiting' ? 'Waiting for you' : 'Working', 'aria-label': live.get(s.id) === 'waiting' ? 'Waiting for you' : 'Working' }) : null,
            h('span', { class: 'sb-chat-title' }, s.title || 'Untitled'),
          ),
          h(
            'button',
            {
              class: 'sb-chat-del',
              type: 'button',
              title: 'Delete chat',
              'aria-label': `Delete chat ${s.title}`,
              onclick: () => void deleteSession(os, s.id).then(() => refresh(active)),
            },
            icon('trash', 15),
          ),
        ),
      );
    }
    if (!shown.length) out.push(h('p', { class: 'sb-empty' }, q ? 'No chats match.' : 'Your chats will appear here.'));
    list.replaceChildren(...out);
  }

  async function refresh(current = active): Promise<void> {
    active = current;
    showProject();
    all = await listSessions(os, currentProject(os).id).catch(() => []);
    render();
  }

  // Which chats are working in the background (sessions keep running when you switch away).
  let pending = 0;
  const updateLive = () => {
    clearTimeout(pending);
    pending = window.setTimeout(async () => {
      const sessions = await agentsOf(os).live().catch(() => []);
      const next = new Map<string, 'running' | 'waiting'>();
      for (const s of sessions) {
        // `waiting` comes from the agent itself (its process ids are its worker's, not the kernel's).
        if (s.busy) next.set(s.sid, (s.waiting ?? os.procs.get(s.pid)?.state === 'blocked') ? 'waiting' : 'running');
      }
      const changed = next.size !== live.size || [...next].some(([k, v]) => live.get(k) !== v);
      live = next;
      // The installed app's icon shows how many chats wait for you.
      setWaitingBadge([...next.values()].filter((v) => v === 'waiting').length);
      if (changed) void refresh(active);
    }, 250);
  };
  os.bus.on('proc:update', (p) => p.kind === 'agent' && updateLive());
  os.bus.on('proc:exit', ({ proc }) => proc.kind === 'agent' && updateLive());
  updateLive();

  const updateKernel = () => {
    const procs = os.procs.list();
    const busy = procs.some((p) => p.kind === 'agent' && p.state === 'running');
    kernelLabel.textContent = `Kernel · ${procs.length} processes`;
    dot.classList.toggle('busy', busy);
  };
  for (const ev of ['proc:spawn', 'proc:exit', 'proc:update'] as const) os.bus.on(ev, updateKernel);
  updateKernel();
  search.addEventListener('input', render);

  return { el, refresh, focusFirst: () => (el.querySelector<HTMLElement>('.sb-new') ?? el).focus() };
}
