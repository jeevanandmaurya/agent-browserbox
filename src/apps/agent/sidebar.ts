import { deleteSession, listSessions, type SessionInfo } from '@/agent/session';
import type { Kernel } from '@/kernel/api';
import { fmtTime, h } from '@/ui/dom';
import { icon } from './icons';

export interface SidebarActions {
  newChat(): void;
  openChat(id: string): void;
  settings(): void;
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
    row('New chat', 'plus', act.newChat, { class: 'sb-row sb-new' }),
    h('label', { class: 'sb-search-wrap' }, icon('search', 16), search),
    h('div', { class: 'sb-scroll' }, list),
    h(
      'div',
      { class: 'sb-foot' },
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
    all = await listSessions(os).catch(() => []);
    render();
  }

  // Which chats are working in the background (sessions keep running when you switch away).
  let pending = 0;
  const updateLive = () => {
    clearTimeout(pending);
    pending = window.setTimeout(async () => {
      const sessions = await os.agents.live().catch(() => []);
      const next = new Map<string, 'running' | 'waiting'>();
      for (const s of sessions) {
        const state = os.procs.get(s.pid)?.state;
        if (s.busy) next.set(s.sid, state === 'blocked' ? 'waiting' : 'running');
      }
      const changed = next.size !== live.size || [...next].some(([k, v]) => live.get(k) !== v);
      live = next;
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
