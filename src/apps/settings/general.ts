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
  return h('div', { class: 'st-section' }, heading('Appearance'), theme.el);
}
