import type { Kernel } from '@/kernel/api';
import { h } from '@/ui/dom';
import { icon, type IconName } from './icons';
import { mountPanelApp, type PanelApp } from './panel-host';

/** Apps the workbench can host, in launcher order. */
export const TOOLS: Array<{ id: string; label: string; icon: IconName; defaults?: Record<string, unknown> }> = [
  { id: 'preview', label: 'Preview', icon: 'eye' },
  { id: 'files', label: 'Files', icon: 'folder', defaults: { path: '/home/agent' } },
  { id: 'editor', label: 'Editor', icon: 'edit' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', defaults: { cwd: '/home/agent' } },
  { id: 'taskmgr', label: 'Processes', icon: 'activity' },
  { id: 'browser', label: 'Browser', icon: 'globe' },
  { id: 'gpulab', label: 'GPU Lab', icon: 'cube' },
  { id: 'sysinfo', label: 'System', icon: 'info' },
];

interface Tab {
  key: string;
  id: string;
  label: string;
  btn: HTMLElement;
  pane: HTMLElement;
  app: PanelApp | null;
}

const WIDTH_KEY = 'bbx-agent-wb-width';
const store = {
  get: (): number | null => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || null;
    } catch {
      return null;
    }
  },
  set: (v: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(v)));
    } catch {
      /* storage blocked */
    }
  },
};

/**
 * The right-hand panel: tabs of embedded apps that stay alive while hidden.
 * Each app chunk is fetched on first use.
 */
export class Workbench {
  readonly el: HTMLElement;
  #tabs: Tab[] = [];
  #active: Tab | null = null;
  #strip = h('div', { class: 'wb-tabs', role: 'tablist', 'aria-label': 'Workbench tools' });
  #panes = h('div', { class: 'wb-panes' });
  #launcher: HTMLElement;
  #menu: HTMLElement;
  #open = false;
  #seq = 0;

  constructor(
    private os: Kernel,
    private host: { onChange(): void; route(id: string, args: Record<string, unknown>): void },
  ) {
    const toolButtons = (cls: string, after?: () => void) =>
      TOOLS.map((t) =>
        h(
          'button',
          {
            class: cls,
            type: 'button',
            onclick: () => {
              after?.();
              this.open(t.id);
            },
          },
          icon(t.icon, 16),
          h('span', null, t.label),
        ),
      );
    this.#launcher = h('div', { class: 'wb-launcher' }, h('p', { class: 'muted' }, 'Tools run inside this window, on the same kernel as the agent.'), h('div', { class: 'wb-grid' }, toolButtons('wb-tool')));
    this.#menu = h('div', { class: 'popover wb-menu', role: 'menu', hidden: true }, toolButtons('pop-item', () => (this.#menu.hidden = true)));
    const addBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Open a tool', 'aria-label': 'Open a tool', 'aria-haspopup': 'menu', onclick: (e: Event) => this.#toggleMenu(e) }, icon('plus', 16));
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Close panel', 'aria-label': 'Close panel', onclick: () => this.hide() }, icon('close', 16));
    const handle = h('div', { class: 'wb-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize panel', tabindex: 0 });
    this.el = h('aside', { class: 'wb', 'aria-label': 'Workbench', hidden: true }, handle, h('div', { class: 'wb-head' }, this.#strip, h('div', { class: 'wb-actions' }, addBtn, closeBtn), this.#menu), this.#panes, this.#launcher);
    this.#resizable(handle);
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!this.#menu.hidden) {
        this.#menu.hidden = true;
        addBtn.focus();
      } else if (this.isSheet) this.hide();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.#menu.hidden && !this.#menu.contains(e.target as Node) && !addBtn.contains(e.target as Node)) this.#menu.hidden = true;
    });
    const w = store.get();
    if (w) this.el.style.setProperty('--wb-w', `${w}px`);
  }

  get isOpen(): boolean {
    return this.#open;
  }
  get activeId(): string | null {
    return this.#open ? (this.#active?.id ?? null) : null;
  }
  get isSheet(): boolean {
    return matchMedia('(max-width: 900px)').matches;
  }

  show(): void {
    if (this.#open) return;
    this.#open = true;
    this.el.hidden = false;
    this.el.parentElement?.classList.add('wb-open');
    this.#active?.app?.setHidden(false);
    this.#refresh();
  }

  hide(): void {
    if (!this.#open) return;
    this.#open = false;
    this.el.hidden = true;
    this.el.parentElement?.classList.remove('wb-open');
    this.#active?.app?.setHidden(true);
    this.host.onChange();
  }

  toggle(): void {
    if (this.#open) this.hide();
    else this.show();
  }

  /** Opens (or focuses) a tool. Arguments re-launch the tool so they take effect, e.g. new preview content. */
  open(id: string, args: Record<string, unknown> = {}): void {
    const tool = TOOLS.find((t) => t.id === id);
    if (!tool) return;
    const key = id === 'editor' && typeof args.path === 'string' ? `editor:${args.path}` : id;
    let tab = this.#tabs.find((t) => t.key === key);
    const fresh = !tab;
    if (!tab) tab = this.#addTab(key, tool);
    if (fresh || !tab.app || (Object.keys(args).length && id !== 'editor')) this.#mount(tab, { ...tool.defaults, ...args });
    this.show();
    this.#select(tab);
  }

  #addTab(key: string, tool: (typeof TOOLS)[number]): Tab {
    const n = ++this.#seq;
    const pane = h('div', { class: 'wb-pane', role: 'tabpanel', id: `wb-pane-${n}`, 'aria-labelledby': `wb-tab-${n}`, hidden: true });
    const label = h('span', { class: 'wb-tab-label' }, tool.label);
    const tab: Tab = { key, id: tool.id, label: tool.label, pane, app: null, btn: h('div') };
    tab.btn = h(
      'div',
      { class: 'wb-tab' },
      h('button', { class: 'wb-tab-main', type: 'button', role: 'tab', id: `wb-tab-${n}`, 'aria-controls': pane.id, 'aria-selected': 'false', onclick: () => this.#select(tab) }, icon(tool.icon, 15), label),
      h('button', { class: 'wb-tab-close', type: 'button', 'aria-label': `Close ${tool.label}`, title: 'Close tab', onclick: () => this.#closeTab(tab) }, icon('close', 13)),
    );
    this.#tabs.push(tab);
    this.#strip.append(tab.btn);
    this.#panes.append(pane);
    return tab;
  }

  #mount(tab: Tab, args: Record<string, unknown>): void {
    const old = tab.app;
    tab.app = null;
    old?.close();
    const app = mountPanelApp(this.os, tab.id, tab.pane, args, {
      launch: (id, a) => this.host.route(id, a),
      onClosed: () => {
        // The app closed itself (or its process was killed): drop the tab unless it is being re-launched.
        if (tab.app === app) this.#closeTab(tab);
      },
      onTitle: (title) => {
        const short = title.replace(/\s+—\s+[^—]+$/, '');
        const text = tab.id === 'editor' || tab.id === 'preview' ? short || tab.label : tab.label;
        tab.btn.querySelector('.wb-tab-label')!.textContent = text;
        tab.btn.title = title;
      },
    });
    tab.app = app;
    app.setHidden(this.#active !== tab || !this.#open);
  }

  #select(tab: Tab): void {
    for (const t of this.#tabs) {
      const on = t === tab;
      t.pane.hidden = !on;
      t.btn.classList.toggle('active', on);
      t.btn.querySelector('[role="tab"]')!.setAttribute('aria-selected', String(on));
      t.app?.setHidden(!on || !this.#open);
    }
    this.#active = tab;
    tab.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.#refresh();
  }

  #closeTab(tab: Tab): void {
    const i = this.#tabs.indexOf(tab);
    if (i < 0) return;
    this.#tabs.splice(i, 1);
    const app = tab.app;
    tab.app = null;
    app?.close();
    tab.btn.remove();
    tab.pane.remove();
    if (this.#active === tab) {
      this.#active = null;
      const next = this.#tabs[Math.min(i, this.#tabs.length - 1)];
      if (next) this.#select(next);
    }
    this.#refresh();
  }

  #refresh(): void {
    this.#launcher.hidden = this.#tabs.length > 0;
    this.#panes.hidden = this.#tabs.length === 0;
    this.host.onChange();
  }

  #toggleMenu(e: Event): void {
    this.#menu.hidden = !this.#menu.hidden;
    if (!this.#menu.hidden) (this.#menu.querySelector('button') as HTMLElement | null)?.focus();
    e.stopPropagation();
  }

  #resizable(handle: HTMLElement): void {
    const clamp = (w: number) => Math.max(320, Math.min(w, (this.el.parentElement?.clientWidth ?? innerWidth) - 420));
    const set = (w: number) => {
      const v = clamp(w);
      this.el.style.setProperty('--wb-w', `${v}px`);
      handle.setAttribute('aria-valuenow', String(Math.round(v)));
      store.set(v);
    };
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('wb-resizing');
      const right = this.el.getBoundingClientRect().right;
      const move = (ev: PointerEvent) => set(right - ev.clientX);
      const up = () => {
        document.body.classList.remove('wb-resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? 32 : e.key === 'ArrowRight' ? -32 : 0;
      if (!step) return;
      e.preventDefault();
      set(this.el.getBoundingClientRect().width + step);
    });
  }
}
