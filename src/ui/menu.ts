import { h } from './dom';
import { icon, type IconName } from './icons';

export type MenuEntry =
  | { label: string; hint?: string; icon?: IconName; checked?: boolean; onSelect(): void }
  | { group: string }
  | { separator: true }
  /** Any element, e.g. a segmented control; it handles its own input. */
  | { element: HTMLElement };

const PHONE = '(max-width: 760px)';
let current: (() => void) | null = null;

/**
 * Opens a menu for `anchor`: a popover next to it on wide screens, a bottom
 * sheet on phones. Closes on selection, Escape, or a tap outside, and returns
 * focus to the anchor.
 */
export function openMenu(anchor: HTMLElement, entries: MenuEntry[], label: string): void {
  current?.();
  const items: HTMLButtonElement[] = [];
  const menu = h(
    'div',
    { class: 'menu', role: 'menu', 'aria-label': label },
    entries.map((e) => {
      if ('group' in e) return h('div', { class: 'pop-group' }, e.group);
      if ('separator' in e) return h('div', { class: 'pop-sep', role: 'separator' });
      if ('element' in e) return e.element;
      const b = h(
        'button',
        {
          class: 'pop-item',
          type: 'button',
          role: e.checked === undefined ? 'menuitem' : 'menuitemradio',
          'aria-checked': e.checked === undefined ? null : String(e.checked),
          onclick: () => {
            close();
            e.onSelect();
          },
        },
        e.icon ? icon(e.icon, 18) : null,
        h('span', { class: 'menu-text' }, h('span', null, e.label), e.hint ? h('span', { class: 'menu-hint' }, e.hint) : null),
        e.checked ? h('span', { class: 'menu-check' }, icon('check', 16)) : null,
      );
      items.push(b);
      return b;
    }),
  );
  const scrim = h('div', { class: 'menu-scrim', onpointerdown: (e: Event) => (e.preventDefault(), close()) });
  document.body.append(scrim, menu);

  if (!matchMedia(PHONE).matches) {
    // Below the anchor if it fits, otherwise above; aligned to whichever edge keeps it on screen.
    const r = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const top = r.bottom + 6 + m.height < innerHeight ? r.bottom + 6 : Math.max(8, r.top - 6 - m.height);
    const left = Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8);
    Object.assign(menu.style, { top: `${top}px`, left: `${r.left + m.width < innerWidth - 8 ? Math.max(8, r.left) : left}px` });
  }
  anchor.setAttribute('aria-expanded', 'true');

  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  addEventListener('keydown', key, true);
  (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true });

  function close(): void {
    if (current !== close) return;
    current = null;
    removeEventListener('keydown', key, true);
    scrim.remove();
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    anchor.focus({ preventScroll: true });
  }
  current = close;
}
