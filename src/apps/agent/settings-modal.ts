import type { Kernel } from '@/kernel/api';
import { h } from '@/ui/dom';
import { icon } from './icons';
import { mountPanelApp, type PanelApp } from './panel-host';

export type SettingsSection = 'model' | 'permissions' | 'appearance' | 'tools' | 'data';

/**
 * Settings inside the agent window: the Settings app module in a modal
 * (a full-screen sheet on phones). Opening it again re-targets the section.
 */
export class SettingsModal {
  #overlay: HTMLElement | null = null;
  #app: PanelApp | null = null;
  #returnFocus: HTMLElement | null = null;

  constructor(
    private os: Kernel,
    private route: (id: string, args: Record<string, unknown>) => void,
  ) {}

  get isOpen(): boolean {
    return this.#overlay !== null;
  }

  open(section: SettingsSection | string = 'model'): void {
    if (!this.#overlay) this.#returnFocus = document.activeElement as HTMLElement | null;
    this.#teardown(false);
    const pane = h('div', { class: 'sm-body' });
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close settings', title: 'Close (Esc)', onclick: () => this.close() }, icon('close', 18));
    const dialog = h('div', { class: 'sm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sm-title' }, h('header', { class: 'sm-head' }, h('h2', { id: 'sm-title' }, 'Settings'), closeBtn), pane);
    const overlay = h('div', { class: 'sm-overlay' }, dialog);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Tab') this.#trap(e, dialog);
    });
    document.body.append(overlay);
    this.#overlay = overlay;
    const app: PanelApp = mountPanelApp(this.os, 'settings', pane, { section }, {
      launch: (id, args) => {
        this.close();
        this.route(id, args);
      },
      // Only when the app closed itself; teardown clears #app before closing it.
      onClosed: () => this.#app === app && this.#teardown(true),
    });
    this.#app = app;
    closeBtn.focus();
  }

  close(): void {
    this.#teardown(true);
  }

  #teardown(restoreFocus: boolean): void {
    const app = this.#app;
    this.#app = null;
    app?.close();
    this.#overlay?.remove();
    this.#overlay = null;
    if (restoreFocus) this.#returnFocus?.focus();
  }

  #trap(e: KeyboardEvent, dialog: HTMLElement): void {
    const items = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
