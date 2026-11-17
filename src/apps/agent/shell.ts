import { h } from '@/ui/dom';
import type { Composer } from './composer';
import { icon, type IconName } from './icons';
import type { Sidebar } from './sidebar';
import type { Transcript } from './view';
import type { Workbench } from './workbench';

const COLLAPSE_KEY = 'bbx-agent-sidebar';
const MOBILE = '(max-width: 760px)';

export interface Shell {
  el: HTMLElement;
  todoSlot: HTMLElement;
  usage: HTMLElement;
  /** Holds the context meter. */
  meterSlot: HTMLElement;
  /** Whether the chat has no messages yet. */
  setEmpty(empty: boolean): void;
  setTitle(title: string): void;
  closeDrawer(): void;
  /** Updates header buttons after the workbench changes. */
  syncWorkbench(): void;
}

export function createShell(parts: { sidebar: Sidebar; workbench: Workbench; composer: Composer; log: Transcript }): Shell {
  const { sidebar, workbench, composer, log } = parts;
  const mobile = matchMedia(MOBILE);

  const toggleBtn = h('button', { class: 'icon-btn bb-sb-toggle', type: 'button', title: 'Open sidebar', 'aria-label': 'Open sidebar', 'aria-expanded': 'false', onclick: () => openSidebar() }, icon('menu', 20));
  const title = h('h1', { class: 'bb-title' }, 'New chat');
  const usage = h('span', { class: 'bb-usage tech' });
  const meterSlot = h('span', { class: 'bb-meter' });
  const headBtn = (label: string, ic: IconName, onclick: () => void, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(ic, 18));
  const filesBtn = headBtn('Files', 'folder', () => workbench.open('files'), 'bb-files');
  const termBtn = headBtn('Terminal', 'terminal', () => workbench.open('terminal'), 'bb-term');
  const wbBtn = headBtn('Toggle workbench', 'panel', () => workbench.toggle(), 'bb-wb-toggle');
  wbBtn.setAttribute('aria-pressed', 'false');
  const head = h('header', { class: 'bb-head' }, toggleBtn, title, h('span', { class: 'spacer' }), usage, meterSlot, filesBtn, termBtn, wbBtn);

  // Shown only while the chat is empty: one quiet line, no hero.
  const hero = h('p', { class: 'bb-hero' }, 'New chat. Type / for commands.');
  const scroller = h('div', { class: 'ag-scroll' }, h('div', { class: 'bb-col' }, hero, log.el));
  const todoSlot = h('div', { class: 'bb-todos' });
  const dockSlot = h('div', { class: 'bb-dock-slot' });
  const dock = h('div', { class: 'bb-dock' }, todoSlot, dockSlot, );
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
  // Swipe the drawer away. (Opening by edge-swipe is left to the menu button: the screen edge belongs to the system's back gesture.)
  let swipe: { x: number; y: number } | null = null;
  for (const target of [sidebar.el, scrim]) {
    target.addEventListener('touchstart', (e) => (swipe = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY }), { passive: true });
    target.addEventListener(
      'touchend',
      (e) => {
        const t = e.changedTouches[0]!;
        if (swipe && swipe.x - t.clientX > 56 && Math.abs(t.clientY - swipe.y) < 48) closeDrawer();
        swipe = null;
      },
      { passive: true },
    );
  }

  return {
    meterSlot,
    el,
    todoSlot,
    usage,
    setEmpty(empty) {
      el.classList.toggle('is-empty', empty);
      hero.hidden = !empty;
      if (composer.el.parentElement !== dockSlot) dockSlot.append(composer.el);
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
