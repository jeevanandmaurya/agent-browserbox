import { h } from '@/ui/dom';
import type { Composer } from './composer';
import { icon, type IconName } from './icons';
import type { Sidebar } from './sidebar';
import type { Transcript } from './view';
import type { Workbench } from './workbench';

const SUGGESTIONS: Array<{ icon: IconName; label: string; prompt: string }> = [
  { icon: 'spark', label: 'Give me a tour', prompt: 'Give me a tour: what can you do in this OS?' },
  { icon: 'eye', label: 'Build a web page', prompt: 'Build a small interactive web page and show it to me' },
  { icon: 'terminal', label: 'Plot with Python', prompt: 'Write a Python script that plots a sine wave, run it, and show the chart' },
  { icon: 'cube', label: 'Benchmark WebGPU', prompt: 'Benchmark a WebGPU compute shader against plain JavaScript' },
];

const COLLAPSE_KEY = 'bbx-agent-sidebar';
const MOBILE = '(max-width: 760px)';

function greeting(): string {
  const hr = new Date().getHours();
  return hr < 5 ? 'Working late?' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

export interface Shell {
  el: HTMLElement;
  todoSlot: HTMLElement;
  usage: HTMLElement;
  /** Empty state (centered composer, suggestions) vs. conversation (docked composer). */
  setEmpty(empty: boolean): void;
  setTitle(title: string): void;
  closeDrawer(): void;
  /** Updates header buttons after the workbench changes. */
  syncWorkbench(): void;
}

export function createShell(parts: { sidebar: Sidebar; workbench: Workbench; composer: Composer; log: Transcript; suggest(prompt: string): void }): Shell {
  const { sidebar, workbench, composer, log } = parts;
  const mobile = matchMedia(MOBILE);

  const toggleBtn = h('button', { class: 'icon-btn bb-sb-toggle', type: 'button', title: 'Open sidebar', 'aria-label': 'Open sidebar', 'aria-expanded': 'false', onclick: () => openSidebar() }, icon('menu', 20));
  const title = h('h1', { class: 'bb-title' }, 'New chat');
  const usage = h('span', { class: 'bb-usage tech' });
  const headBtn = (label: string, ic: IconName, onclick: () => void, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(ic, 18));
  const filesBtn = headBtn('Files', 'folder', () => workbench.open('files'), 'bb-files');
  const termBtn = headBtn('Terminal', 'terminal', () => workbench.open('terminal'), 'bb-term');
  const wbBtn = headBtn('Toggle workbench', 'panel', () => workbench.toggle(), 'bb-wb-toggle');
  wbBtn.setAttribute('aria-pressed', 'false');
  const head = h('header', { class: 'bb-head' }, toggleBtn, title, h('span', { class: 'spacer' }), usage, filesBtn, termBtn, wbBtn);

  const chips = h(
    'div',
    { class: 'bb-chips' },
    SUGGESTIONS.map((s) => h('button', { class: 'bb-chip', type: 'button', title: s.prompt, onclick: () => parts.suggest(s.prompt) }, icon(s.icon, 16), h('span', null, s.label))),
  );
  const heroSlot = h('div', { class: 'bb-hero-slot' });
  const hero = h('section', { class: 'bb-hero', 'aria-label': 'Start a chat' }, h('div', { class: 'bb-hero-mark', 'aria-hidden': 'true' }, icon('cube', 28)), h('h2', { class: 'bb-greet' }, greeting()), heroSlot, chips);
  const scroller = h('div', { class: 'ag-scroll' }, h('div', { class: 'bb-col' }, hero, log.el));
  const todoSlot = h('div', { class: 'bb-todos' });
  const dockSlot = h('div', { class: 'bb-dock-slot' });
  const dock = h('div', { class: 'bb-dock' }, todoSlot, dockSlot, h('p', { class: 'bb-foot' }, 'Runs in a sandbox in this tab. The agent can make mistakes — check important work.'));
  const main = h('main', { class: 'bb-main' }, head, scroller, dock);
  const scrim = h('div', { class: 'bb-scrim', onclick: () => closeDrawer() });
  const el = h('div', { class: 'bb' }, sidebar.el, scrim, main, workbench.el);

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    /* storage blocked */
  }
  el.classList.toggle('sb-collapsed', collapsed);

  function openSidebar(): void {
    if (mobile.matches) {
      el.classList.add('drawer-open');
      toggleBtn.setAttribute('aria-expanded', 'true');
      sidebar.focusFirst();
    } else setCollapsed(false);
  }
  function setCollapsed(v: boolean): void {
    collapsed = v;
    el.classList.toggle('sb-collapsed', v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    if (v) toggleBtn.focus();
  }
  function closeDrawer(): void {
    if (!el.classList.contains('drawer-open')) return;
    el.classList.remove('drawer-open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.focus();
  }
  // The sidebar's own close button: hide the drawer on phones, collapse on wide screens.
  sidebar.el.addEventListener('bb-collapse', () => (mobile.matches ? closeDrawer() : setCollapsed(true)));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('drawer-open')) {
      e.preventDefault();
      closeDrawer();
    }
  });
  mobile.addEventListener('change', () => closeDrawer());

  return {
    el,
    todoSlot,
    usage,
    setEmpty(empty) {
      el.classList.toggle('is-empty', empty);
      hero.hidden = !empty;
      (empty ? heroSlot : dockSlot).append(composer.el);
    },
    setTitle(text) {
      title.textContent = text || 'New chat';
    },
    closeDrawer,
    syncWorkbench() {
      const id = workbench.activeId;
      wbBtn.setAttribute('aria-pressed', String(workbench.isOpen));
      filesBtn.classList.toggle('on', id === 'files');
      termBtn.classList.toggle('on', id === 'terminal');
    },
  };
}
