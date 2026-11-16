/** A small accessible context menu positioned inside the app's root. */
import { h } from '@/ui/dom';

export type MenuItem = { label: string; action: () => void; disabled?: boolean; danger?: boolean; hint?: string } | 'sep';

let closeCurrent: (() => void) | null = null;

export function openMenu(host: HTMLElement, clientX: number, clientY: number, items: MenuItem[], returnFocus?: HTMLElement): void {
  closeCurrent?.();
  const buttons: HTMLButtonElement[] = [];
  const menu = h(
    'div',
    { class: 'ctx-menu', role: 'menu' },
    items.map((it) => {
      if (it === 'sep') return h('div', { class: 'ctx-sep', role: 'separator' });
      const b = h(
        'button',
        {
          class: `ctx-item${it.danger ? ' danger' : ''}`,
          role: 'menuitem',
          disabled: it.disabled,
          tabindex: -1,
          onclick: () => {
            close();
            it.action();
          },
        },
        h('span', null, it.label),
        it.hint && h('kbd', null, it.hint),
      );
      if (!it.disabled) buttons.push(b);
      return b;
    }),
  );

  const move = (d: number) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + d + buttons.length) % buttons.length]?.focus();
  };
  menu.addEventListener('keydown', (e) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Home: () => buttons[0]?.focus(),
      End: () => buttons[buttons.length - 1]?.focus(),
      Escape: () => close(true),
      Tab: () => close(true),
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  });
  const outside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };

  function close(refocus = false): void {
    if (!menu.isConnected) return;
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    closeCurrent = null;
    if (refocus) returnFocus?.focus();
  }
  closeCurrent = close;

  host.append(menu);
  // Position relative to the host (a fixed menu would be clipped by the window's containment).
  const r = host.getBoundingClientRect();
  const x = Math.min(clientX - r.left + host.scrollLeft, host.scrollLeft + host.clientWidth - menu.offsetWidth - 4);
  const y = Math.min(clientY - r.top + host.scrollTop, host.scrollTop + host.clientHeight - menu.offsetHeight - 4);
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;
  document.addEventListener('pointerdown', outside, true);
  buttons[0]?.focus();
}

export function closeMenu(): void {
  closeCurrent?.();
}
