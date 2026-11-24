import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import type { AppContext } from '@/ui/apps';
import { h } from '@/ui/dom';
import { wallpaperPicker, wallpaperThumb } from '@/ui/wallpaper';
import { GRAPHITE_LIGHT, resolveTheme, THEMES, type Theme } from '@/ui/themes';
import { heading, nextId } from './nav';

/** The theme setting: a theme id, or 'system' (Graphite, light or dark as the device prefers). */
export const readTheme = (os: Kernel): string => os.settings.get<string>('ui.theme', 'system');

/** A theme as a little picture: its wallpaper behind a window in its colours. */
function themeCard(theme: Theme, label: string, mood: string, value: string, os: Kernel, saved: () => void): HTMLElement {
  const p = theme.palette;
  const mock = h(
    'span',
    { class: 'th-window', style: `background:${p.panel};border-color:${p.border};color:${p.text}` },
    h('span', { class: 'th-bar', style: `background:${p.panel2}` }, h('i', { style: `background:${p.err}` }), h('i', { style: `background:${p.warn}` }), h('i', { style: `background:${p.ok}` })),
    h('span', { class: 'th-line', style: `background:${p.muted};width:70%` }),
    h('span', { class: 'th-line', style: `background:${p.muted};width:45%` }),
    h('span', { class: 'th-pill', style: `background:${p.accent}` }),
  );
  return h(
    'button',
    { class: 'th-card', type: 'button', dataset: { theme: value }, 'aria-label': `${label}: ${mood}`, onclick: () => (os.settings.set('ui.theme', value), saved()) },
    h('span', { class: 'th-preview', style: `background:url("${wallpaperThumb(theme.wallpapers[0]!, theme, 160, 100)}") center / cover` }, mock),
    h('span', { class: 'th-name' }, label),
    h('span', { class: 'th-mood muted' }, mood),
    h('span', { class: 'th-dots', 'aria-hidden': 'true' }, [p.accent, p.ok, p.warn, p.err, p.blue, p.magenta].map((c) => h('i', { style: `background:${c}` }))),
  );
}

export function appearanceSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  // Themes colour everything together: windows, terminal colours and the wallpaper.
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cards = h(
    'div',
    { class: 'th-grid', role: 'group', 'aria-label': 'Theme' },
    themeCard(resolveTheme('system', systemDark), 'Match device', 'Graphite, light or dark as your device is', 'system', os, saved),
    THEMES.map((t) => themeCard(t, t.name, t.mood, t.id, os, saved)),
    themeCard(GRAPHITE_LIGHT, GRAPHITE_LIGHT.name, GRAPHITE_LIGHT.mood, 'light', os, saved),
  );
  const mark = () => {
    const v = readTheme(os);
    // 'dark' was Graphite before themes.
    const chosen = v === 'dark' ? 'graphite' : v;
    for (const b of cards.querySelectorAll<HTMLElement>('.th-card')) b.setAttribute('aria-pressed', String(b.dataset.theme === chosen));
  };
  mark();
  ctx.on('settings:change', ({ key }) => key === 'ui.theme' && mark());
  const theme = { el: h('div', { class: 'field' }, h('h3', null, 'Theme'), cards) };
  const name = h('input', { class: 'input', id: nextId('name'), value: os.settings.get<string>('user.name', ''), placeholder: 'Optional', autocomplete: 'given-name', maxlength: 40 });
  name.addEventListener('change', () => {
    os.settings.set('user.name', name.value.trim());
    void import('@/app/profile-name').then((m) => m.nameProfileAfterUser(os, name.value.trim()));
    saved();
  });
  return h('div', { class: 'st-section' }, heading('Appearance'), theme.el, h('div', { class: 'field' }, h('label', { for: name.id }, 'Your name, for the greeting'), name), h('h3', null, 'Wallpaper'), wallpaperPicker(os, ctx.on));
}
