import { ANTHROPIC_MODELS, describeModel, loadConfig, saveConfig, type AgentConfig, type Effort } from '@/agent/config';
import type { Kernel } from '@/kernel/api';
import { h } from '@/ui/dom';
import { icon } from './icons';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };

interface Choice {
  group: string;
  name: string;
  hint: string;
  active: (c: AgentConfig) => boolean;
  patch: Partial<AgentConfig>;
}

function choices(cfg: AgentConfig): Choice[] {
  const list: Choice[] = ANTHROPIC_MODELS.map((m) => {
    const [name, hint = ''] = m.label.split(' — ');
    return { group: 'Cloud', name: name!, hint, active: (c) => c.provider === 'anthropic' && c.anthropicModel === m.id, patch: { provider: 'anthropic', anthropicModel: m.id } };
  });
  if (!ANTHROPIC_MODELS.some((m) => m.id === cfg.anthropicModel)) list.push({ group: 'Cloud', name: cfg.anthropicModel, hint: 'custom model id', active: (c) => c.provider === 'anthropic', patch: { provider: 'anthropic' } });
  if (cfg.openaiModel) list.push({ group: 'Local server', name: cfg.openaiModel, hint: cfg.openaiBaseUrl.replace(/^https?:\/\//, ''), active: (c) => c.provider === 'openai', patch: { provider: 'openai' } });
  list.push({ group: 'In this browser', name: cfg.webllmModel.replace(/-q4f16_1-MLC$/, ''), hint: 'WebGPU, offline', active: (c) => c.provider === 'webllm', patch: { provider: 'webllm' } });
  return list;
}

/** Short label for the composer button. */
export function modelLabel(cfg: AgentConfig): string {
  if (cfg.provider === 'anthropic') return ANTHROPIC_MODELS.find((m) => m.id === cfg.anthropicModel)?.label.split(' — ')[0] ?? cfg.anthropicModel;
  if (cfg.provider === 'openai') return cfg.openaiModel || 'Local server';
  return cfg.webllmModel.replace(/-q4f16_1-MLC$/, '');
}

/** The composer's model dropdown: switch among configured models, set effort, or open full settings. */
export function modelPicker(os: Kernel, openSettings: () => void): { el: HTMLElement; refresh(): void } {
  const label = h('span', { class: 'mp-label' });
  const btn = h('button', { class: 'mp-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => (menu.hidden ? openMenu() : closeMenu(true)) }, label, icon('chevron', 14));
  const menu = h('div', { class: 'popover mp-menu', role: 'menu', 'aria-label': 'Model', hidden: true });
  const el = h('div', { class: 'mp' }, btn, menu);

  const refresh = () => {
    const cfg = loadConfig(os);
    label.textContent = modelLabel(cfg);
    btn.title = `Model: ${describeModel(cfg)}`;
    btn.setAttribute('aria-label', `Model: ${modelLabel(cfg)}. Change model`);
  };

  function build(): void {
    const cfg = loadConfig(os);
    const items: HTMLElement[] = [];
    let group = '';
    for (const c of choices(cfg)) {
      if (c.group !== group) items.push(h('div', { class: 'pop-group' }, (group = c.group)));
      const on = c.active(cfg);
      items.push(
        h(
          'button',
          { class: `pop-item mp-item ${on ? 'on' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(on), onclick: () => pick(c.patch) },
          h('span', { class: 'mp-item-text' }, h('span', { class: 'mp-name' }, c.name), c.hint ? h('span', { class: 'mp-hint' }, c.hint) : null),
          on ? icon('check', 16) : null,
        ),
      );
    }
    if (cfg.provider === 'anthropic') {
      items.push(
        h('div', { class: 'pop-group' }, 'Effort'),
        h(
          'div',
          { class: 'mp-effort', role: 'group', 'aria-label': 'Effort' },
          EFFORTS.map((e) => h('button', { class: `mp-eff ${cfg.effort === e ? 'on' : ''}`, type: 'button', 'aria-pressed': String(cfg.effort === e), onclick: () => pick({ effort: e }) }, EFFORT_LABEL[e])),
        ),
      );
    }
    items.push(
      h('div', { class: 'pop-sep' }),
      h(
        'button',
        {
          class: 'pop-item',
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            closeMenu(false);
            openSettings();
          },
        },
        icon('gear', 16),
        h('span', null, 'Model settings…'),
      ),
    );
    menu.replaceChildren(...items);
  }

  function pick(patch: Partial<AgentConfig>): void {
    saveConfig(os, patch);
    refresh();
    if (patch.effort) build();
    else closeMenu(true);
  }

  function openMenu(): void {
    build();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    (menu.querySelector<HTMLElement>('.pop-item.on') ?? menu.querySelector<HTMLElement>('.pop-item'))?.focus();
    document.addEventListener('pointerdown', outside, true);
  }

  function closeMenu(refocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) btn.focus();
  }

  const outside = (e: Event) => {
    if (!el.contains(e.target as Node)) closeMenu(false);
  };

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll<HTMLElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });

  refresh();
  return { el, refresh };
}
