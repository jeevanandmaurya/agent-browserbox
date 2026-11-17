import type { Kernel } from '@/kernel/api';
import type { AppContext } from '@/ui/apps';
import { h } from '@/ui/dom';
import { heading, nextId } from './nav';
import { radioGroup } from './permissions';

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

export function appearanceSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const theme = radioGroup('Theme', THEMES, readTheme(os), (v) => {
    os.settings.set('ui.theme', v);
    saved();
  });
  ctx.on('settings:change', ({ key }) => {
    if (key === 'ui.theme') theme.set(readTheme(os));
  });
  const name = h('input', { class: 'input', id: nextId('name'), value: os.settings.get<string>('user.name', ''), placeholder: 'Optional', autocomplete: 'given-name', maxlength: 40 });
  name.addEventListener('change', () => {
    os.settings.set('user.name', name.value.trim());
    saved();
  });
  return h('div', { class: 'st-section' }, heading('Appearance'), theme.el, h('div', { class: 'field' }, h('label', { for: name.id }, 'Your name, for the greeting'), name));
}
