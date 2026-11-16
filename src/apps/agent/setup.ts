import './setup.css';
import { DEFAULT_PACKS, PACKS_KEY } from '@/agent/packs';
import type { Kernel } from '@/kernel/api';
import type { PermMode } from '@/kernel/perms';
import { h } from '@/ui/dom';
import { packList, PROFILES, readProfile, readTheme, THEMES } from '../settings/general';
import { icon } from './icons';
import { mountPanelApp, type PanelApp } from './panel-host';

export const SETUP_KEY = 'setup.done';

const MODES: Array<{ id: PermMode; title: string; text: string }> = [
  { id: 'ask', title: 'Ask me first', text: 'The agent asks before it changes files, runs code, uses the network or controls the system.' },
  { id: 'auto', title: 'Allow everything in the sandbox', text: 'No prompts: the agent acts freely inside BrowserBox, which can never touch your real files.' },
];

let uid = 0;
/** Radio cards; calls `onPick` immediately so choices apply live. */
function choices<T extends string>(legend: string, opts: Array<{ id: T; title: string; text?: string }>, value: T, onPick: (v: T) => void, cls = ''): HTMLElement {
  const name = `su-${++uid}`;
  return h(
    'fieldset',
    { class: `su-choices ${cls}` },
    h('legend', null, legend),
    opts.map((o) =>
      h('label', { class: 'su-choice' }, h('input', { type: 'radio', name, value: o.id, checked: o.id === value, onchange: () => onPick(o.id) }), h('span', { class: 'su-choice-text' }, h('strong', null, o.title), o.text ? h('span', null, o.text) : null)),
    ),
  );
}

/**
 * First-run setup: a short, skippable full-page flow (style, model,
 * permissions, tools). Every choice is saved as it is made; finishing or
 * "Use defaults" marks setup done and hands over to the chat.
 */
export function createSetup(os: Kernel, done: () => void): { el: HTMLElement; remove(): void } {
  let step = 0;
  let model: PanelApp | null = null;
  const set = (key: string, value: unknown) => os.settings.set(key, value);
  const has = (key: string) => os.settings.keys().includes(key);

  const steps: Array<{ title: string; sub: string; build(): HTMLElement }> = [
    {
      title: 'How do you like to work?',
      sub: 'Pick a style for the agent window. You can change it any time in Settings → Appearance.',
      build: () =>
        h(
          'div',
          { class: 'su-stack' },
          choices('Style', PROFILES, readProfile(os), (v) => set('ui.profile', v), 'su-big'),
          choices('Theme', THEMES, readTheme(os), (v) => set('ui.theme', v), 'su-row'),
        ),
    },
    {
      title: 'Choose a model',
      sub: 'Pick where the agent’s model runs and enter what it needs. You can skip this and set it up later.',
      build: () => {
        const pane = h('div', { class: 'su-model' });
        model = mountPanelApp(os, 'settings', pane, { only: 'model' }, { launch: () => undefined, onClosed: () => undefined });
        return pane;
      },
    },
    {
      title: 'Permissions',
      sub: 'Everything runs in a sandbox inside this tab. Decide how much the agent may do without asking.',
      build: () => choices('When the agent wants to act', MODES, os.perms.mode, (m) => (os.perms.mode = m), 'su-big'),
    },
    {
      title: 'Tools',
      sub: 'Optional packs for the agent. Each downloads only when it is first used, and you can change them later in Settings → Tools.',
      build: () => packList(os),
    },
  ];

  const titleEl = h('h1', { class: 'su-title', tabindex: -1 });
  const subEl = h('p', { class: 'su-sub' });
  const body = h('div', { class: 'su-body' });
  const count = h('span', { class: 'su-count' });
  const dots = h('ol', { class: 'su-dots', 'aria-hidden': 'true' }, steps.map(() => h('li')));
  const backBtn = h('button', { class: 'btn su-btn', type: 'button', onclick: () => go(step - 1) }, 'Back');
  const nextBtn = h('button', { class: 'btn primary su-btn', type: 'submit' }, 'Continue');
  const form = h(
    'form',
    {
      class: 'su-card',
      'aria-labelledby': 'su-title',
      onsubmit: (e: Event) => {
        e.preventDefault();
        if (step < steps.length - 1) go(step + 1);
        else finish();
      },
    },
    h('div', { class: 'su-progress' }, count, dots),
    titleEl,
    subEl,
    body,
    h('div', { class: 'su-nav' }, backBtn, h('span', { class: 'spacer' }), nextBtn),
  );
  titleEl.id = 'su-title';
  const el = h(
    'div',
    { class: 'su', role: 'main' },
    h(
      'header',
      { class: 'su-head' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('cube', 16)), h('span', { class: 'brand-name' }, 'BrowserBox')),
      h('button', { class: 'btn su-skip', type: 'button', onclick: () => useDefaults() }, 'Use defaults'),
    ),
    h('div', { class: 'su-scroll' }, h('div', { class: 'su-intro' }, h('p', null, 'Welcome. A few quick choices and you are ready — or use the defaults and start chatting.')), form),
  );

  function go(n: number): void {
    model?.close();
    model = null;
    step = Math.max(0, Math.min(n, steps.length - 1));
    const s = steps[step]!;
    titleEl.textContent = s.title;
    subEl.textContent = s.sub;
    body.replaceChildren(s.build());
    count.textContent = `Step ${step + 1} of ${steps.length}`;
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i <= step));
    backBtn.hidden = step === 0;
    nextBtn.textContent = step === steps.length - 1 ? 'Finish' : 'Continue';
    el.querySelector('.su-scroll')!.scrollTop = 0;
    titleEl.focus({ preventScroll: true });
  }

  function finish(): void {
    if (!has(PACKS_KEY)) set(PACKS_KEY, DEFAULT_PACKS);
    if (!has('ui.profile')) set('ui.profile', 'casual');
    set(SETUP_KEY, true);
    remove();
    done();
  }

  /** Keeps anything already chosen; fills the rest with defaults. */
  function useDefaults(): void {
    if (!has('perms.mode')) os.perms.mode = 'ask';
    finish();
  }

  function remove(): void {
    model?.close();
    model = null;
    el.remove();
  }

  go(0);
  return { el, remove };
}
