import { h } from '@/ui/dom';

export interface Section {
  id: string;
  label: string;
  build(): HTMLElement;
}

/**
 * Left-hand section nav that becomes a horizontal tab strip in narrow windows
 * (see the container query in style.css). Sections are built on first visit.
 */
export function sectionNav(sections: Section[], label: string, uid: number) {
  const built = new Map<string, HTMLElement>();
  const main = h('div', { class: 'sn-main' });
  const buttons = sections.map((s) =>
    h('button', { class: 'sn-tab', type: 'button', role: 'tab', id: `sn-${uid}-${s.id}`, 'aria-controls': `sn-${uid}-panel`, onclick: () => show(s.id) }, s.label),
  );
  const nav = h('nav', { class: 'sn-nav', role: 'tablist', 'aria-label': label, 'aria-orientation': 'vertical' }, buttons);
  const panel = h('div', { class: 'sn-panel', role: 'tabpanel', id: `sn-${uid}-panel`, tabindex: -1 }, main);
  let current = '';

  nav.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (i < 0 || !delta) return;
    e.preventDefault();
    const next = sections[(i + delta + sections.length) % sections.length]!;
    show(next.id);
    buttons[sections.indexOf(next)]!.focus();
  });

  function show(id: string): void {
    const s = sections.find((x) => x.id === id) ?? sections[0]!;
    if (s.id === current) return;
    current = s.id;
    buttons.forEach((b, i) => {
      const on = sections[i] === s;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && nav.scrollWidth > nav.clientWidth) {
        // Keep the active tab visible in the horizontal strip (scrollIntoView would also scroll the desktop).
        const nr = nav.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        if (br.left < nr.left || br.right > nr.right) nav.scrollLeft += br.left - nr.left - 8;
      }
    });
    panel.setAttribute('aria-labelledby', `sn-${uid}-${s.id}`);
    let el = built.get(s.id);
    if (!el) built.set(s.id, (el = s.build()));
    main.replaceChildren(el);
    panel.scrollTop = 0;
  }

  return {
    el: h('div', { class: 'sn-layout' }, nav, panel),
    show,
    /** Drops cached sections so they rebuild from fresh state on next visit. */
    invalidate(): void {
      built.clear();
      const id = current;
      current = '';
      show(id);
    },
  };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function heading(title: string, sub?: string): HTMLElement {
  return h('header', { class: 'st-head' }, h('h2', null, title), sub ? h('p', { class: 'muted' }, sub) : null);
}

let uid = 0;
/** Unique id for label/aria wiring (several Settings windows never coexist, but sections rebuild). */
export function nextId(prefix: string): string {
  return `st-${prefix}-${++uid}`;
}
