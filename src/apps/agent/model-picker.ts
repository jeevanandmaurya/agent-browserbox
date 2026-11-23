import { ANTHROPIC_MODELS, describeModel, loadConfig, saveConfig, type AgentConfig, type Effort } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@/kernel/api';
import { h } from '@/ui/dom';
import type { MenuEntry } from '@/ui/menu';

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
  if (cfg.localModel) list.push({ group: 'Local server', name: cfg.localModel, hint: cfg.localBaseUrl.replace(/^https?:\/\//, ''), active: (c) => c.provider === 'local', patch: { provider: 'local' } });
  if (cfg.openaiModel) list.push({ group: 'OpenAI-compatible API', name: cfg.openaiModel, hint: cfg.openaiBaseUrl.replace(/^https?:\/\//, ''), active: (c) => c.provider === 'openai', patch: { provider: 'openai' } });
  list.push({ group: 'In this browser', name: cfg.webllmModel.replace(/-q4f16_1-MLC$/, ''), hint: 'WebGPU, offline', active: (c) => c.provider === 'webllm', patch: { provider: 'webllm' } });
  return list;
}

/** Short label for the composer button. */
export function modelLabel(cfg: AgentConfig): string {
  if (cfg.provider === 'anthropic') return ANTHROPIC_MODELS.find((m) => m.id === cfg.anthropicModel)?.label.split(' — ')[0] ?? cfg.anthropicModel;
  if (cfg.provider === 'local') return cfg.localModel || 'Local server';
  if (cfg.provider === 'openai') return cfg.openaiModel || 'OpenAI-compatible API';
  return cfg.webllmModel.replace(/-q4f16_1-MLC$/, '');
}

/** Menu entries for switching model and effort; `refresh` runs after a change. */
export function modelMenuEntries(os: Kernel, openSettings: () => void, refresh: () => void): MenuEntry[] {
  const cfg = loadConfig(os);
  const entries: MenuEntry[] = [];
  let group = '';
  for (const c of choices(cfg)) {
    if (c.group !== group) entries.push({ group: (group = c.group) });
    entries.push({
      label: c.name,
      hint: c.hint,
      checked: c.active(cfg),
      onSelect: () => {
        saveConfig(os, c.patch);
        refresh();
      },
    });
  }
  if (cfg.provider === 'anthropic') {
    const row = h('div', { class: 'mp-effort', role: 'group', 'aria-label': 'Effort' });
    const paint = () =>
      row.replaceChildren(
        ...EFFORTS.map((e) =>
          h(
            'button',
            {
              class: `mp-eff ${loadConfig(os).effort === e ? 'on' : ''}`,
              type: 'button',
              'aria-pressed': String(loadConfig(os).effort === e),
              onclick: () => {
                saveConfig(os, { effort: e });
                paint();
                refresh();
              },
            },
            EFFORT_LABEL[e],
          ),
        ),
      );
    paint();
    entries.push({ group: 'Effort' }, { element: row });
  }
  entries.push({ separator: true }, { label: 'Model settings…', icon: 'gear', onSelect: openSettings });
  return entries;
}
