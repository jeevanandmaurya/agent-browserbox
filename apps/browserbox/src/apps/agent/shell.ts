import { h } from '@/ui/dom';
import type { Composer } from './composer';
import { icon, mark } from './icons';
import type { Sidebar } from './sidebar';
import type { Transcript } from './view';
import type { Workbench } from './workbench';

const COLLAPSE_KEY = 'bbx-agent-sidebar';
const MOBILE = '(max-width: 760px)';

export interface Shell {
  el: HTMLElement;
  todoSlot: HTMLElement;
  /** Holds the context meter. */
  meterSlot: HTMLElement;
  /** Whether the chat has no messages yet. */
  setEmpty(empty: boolean): void;
  setTitle(title: string): void;
  /** The model name, shown on the composer's model picker. */
  setSubtitle(text: string): void;
  setBusy(busy: boolean): void;
  /** Marks the chat as private (not saved). */
  setPrivate(on: boolean): void;
  closeDrawer(): void;
  /** Updates header buttons after the workbench changes. */
  syncWorkbench(): void;
}

export interface ShellActions {
  /** The ⋮ menu. */
  more(anchor: HTMLElement): void;
  /** Name for the greeting, if the user gave one. */
  name(): string;
  /** The private-chat toggle (shown on an empty or private chat). */
  togglePrivate(): void;
}

function greeting(name: string): string {
  const hr = new Date().getHours();
  const part = hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

export function createShell(parts: { sidebar: Sidebar; workbench: Workbench; composer: Composer; log: Transcript; actions: ShellActions }): Shell {
  const { sidebar, workbench, composer, log, actions } = parts;
  const mobile = matchMedia(MOBILE);

  // Header: menu · title · status · ⋮ (the model picker is under the message box)
  const toggleBtn = h('button', { class: 'icon-btn bb-sb-toggle', type: 'button', title: 'Chats', 'aria-label': 'Open chats', 'aria-expanded': 'false', onclick: () => openSidebar() }, icon('menu', 22));
  const title = h('h1', { class: 'bb-title' });
  const titleBox = h('div', { class: 'bb-titlebox' }, title);
  const wbBtn = h('button', { class: 'icon-btn bb-wb-toggle', type: 'button', title: 'Workbench', 'aria-label': 'Toggle workbench', 'aria-pressed': 'false', onclick: () => workbench.toggle() }, icon('panel', 20));
  const privateBtn = h('button', { class: 'icon-btn bb-private', type: 'button', title: 'Private chat', 'aria-label': 'Private chat: not saved, gone when you leave', 'aria-pressed': 'false', onclick: () => actions.togglePrivate() }, icon('ghost', 22));
  const moreBtn = h('button', { class: 'icon-btn bb-more', type: 'button', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu', onclick: () => actions.more(moreBtn) }, icon('more', 22));
  const head = h('header', { class: 'bb-head' }, toggleBtn, titleBox, h('div', { class: 'bb-head-end' }, privateBtn, wbBtn, moreBtn));

  // An empty chat is just the mark and a greeting.
  const greet = h('h2', { class: 'bb-greet' });
  const privateNote = h('p', { class: 'bb-private-note', hidden: true }, 'Not saved, and gone when you leave this chat.');
  const hero = h('section', { class: 'bb-hero', 'aria-label': 'New chat' }, mark(36), greet, privateNote);
  const scroller = h('div', { class: 'ag-scroll' }, h('div', { class: 'bb-col' }, hero, log.el));
  const todoSlot = h('div', { class: 'bb-todos' });
  const dock = h('div', { class: 'bb-dock' }, todoSlot, composer.el);
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
    meterSlot: composer.meterSlot,
    el,
    todoSlot,
    setEmpty(empty) {
      el.classList.toggle('is-empty', empty);
      hero.hidden = !empty;
      if (empty && !el.classList.contains('is-private')) greet.textContent = greeting(actions.name());
    },
    setTitle(text) {
      title.textContent = text;
      title.hidden = !text;
    },
    setSubtitle(text) {
      composer.setModel(text);
    },
    // What the agent is doing shows at the end of the conversation; the header stays quiet.
    setBusy(busy) {
      el.classList.toggle('is-busy', busy);
    },
    setPrivate(on) {
      el.classList.toggle('is-private', on);
      privateBtn.setAttribute('aria-pressed', String(on));
      privateNote.hidden = !on;
      greet.textContent = on ? 'Private chat' : greeting(actions.name());
      composer.input.dataset.base = on ? 'Private message' : 'Message BrowserBox';
      composer.syncMode();
    },
    closeDrawer,
    syncWorkbench() {
      wbBtn.setAttribute('aria-pressed', String(workbench.isOpen));
    },
  };
}
