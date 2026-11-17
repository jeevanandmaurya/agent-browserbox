import { DEFAULT_PACKS, PACKS, PACKS_KEY } from '@/agent/packs';
import type { Kernel } from '@/kernel/api';
import type { AppContext } from '@/ui/apps';
import { h } from '@/ui/dom';
import { heading, nextId } from './nav';
import { radioGroup } from './permissions';
import './packs.css';

type Theme = 'dark' | 'light' | 'system';

export const THEMES: Array<{ id: Theme; title: string }> = [
  { id: 'system', title: 'Match system' },
  { id: 'dark', title: 'Dark' },
  { id: 'light', title: 'Light' },
];
export const readTheme = (os: Kernel): Theme => {
  const v = os.settings.get<string>('ui.theme', 'dark');
  return v === 'light' || v === 'system' ? v : 'dark';
};

/** Checklist of tool packs; unavailable ones are shown as "coming soon" and cannot be picked. */
export function packList(os: Kernel, onChange?: () => void): HTMLElement {
  const selected = new Set(os.settings.get<string[]>(PACKS_KEY, DEFAULT_PACKS));
  return h(
    'div',
    { class: 'pk-list', role: 'group', 'aria-label': 'Tool packs' },
    PACKS.map((p) => {
      const id = nextId('pack');
      const box = h('input', {
        type: 'checkbox',
        id,
        checked: p.available && selected.has(p.id),
        disabled: !p.available,
        onchange: () => {
          if (box.checked) selected.add(p.id);
          else selected.delete(p.id);
          os.settings.set(PACKS_KEY, PACKS.filter((x) => x.available && selected.has(x.id)).map((x) => x.id));
          onChange?.();
        },
      });
      return h(
        'label',
        { class: `pk-item ${p.available ? '' : 'soon'}`, for: id },
        box,
        h('span', { class: 'pk-text' }, h('span', { class: 'pk-name' }, p.name, h('span', { class: 'pk-size' }, p.size), p.available ? null : h('span', { class: 'pk-soon' }, 'Coming soon')), h('span', { class: 'pk-desc' }, p.description)),
      );
    }),
  );
}

export function appearanceSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const theme = radioGroup('Theme', THEMES, readTheme(os), (v) => {
    os.settings.set('ui.theme', v);
    saved();
  });
  ctx.on('settings:change', ({ key }) => {
    if (key === 'ui.theme') theme.set(readTheme(os));
  });
  return h('div', { class: 'st-section' }, heading('Appearance'), theme.el);
}

export function toolsSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  return h(
    'div',
    { class: 'st-section' },
    heading('Tools', 'Optional packs for the agent. Each downloads only when it is first used.'),
    packList(os, saved),
    h('h3', null, 'First-run setup'),
    h('p', { class: 'st-note muted' }, 'Walk through style, model, permissions and tools again. Nothing is reset.'),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            os.settings.set('setup.done', false);
            // The agent window shows setup as soon as this flips; elsewhere it shows on next open.
            if (!document.querySelector('.bb')) os.notify({ title: 'Setup will run the next time you open the agent window' });
            else ctx.win.close();
          },
        },
        'Run setup again',
      ),
    ),
  );
}
