import { loadConfig, saveConfig, type AgentConfig } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import type { MenuEntry } from '@/ui/menu';

interface Choice {
  group: string;
  name: string;
  hint: string;
  active: (c: AgentConfig) => boolean;
  patch: Partial<AgentConfig>;
}

const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const webgpuName = (id: string) => id.replace(/-q4f16_1-MLC$/, '');

/** One entry per configured source: the API, the local server and the in-browser model. */
function choices(cfg: AgentConfig): Choice[] {
  const list: Choice[] = [];
  if (cfg.apiModel) list.push({ group: 'API', name: cfg.apiModel, hint: host(cfg.apiBaseUrl), active: (c) => c.provider === 'api', patch: { provider: 'api' } });
  if (cfg.localModel) list.push({ group: 'Local server', name: cfg.localModel, hint: host(cfg.localBaseUrl), active: (c) => c.provider === 'local', patch: { provider: 'local' } });
  list.push({ group: 'In this browser', name: webgpuName(cfg.webgpuModel), hint: 'WebGPU, offline', active: (c) => c.provider === 'webgpu', patch: { provider: 'webgpu' } });
  return list;
}

/** Short label for the composer button. */
export function modelLabel(cfg: AgentConfig): string {
  if (cfg.provider === 'api') return cfg.apiModel || 'API';
  if (cfg.provider === 'local') return cfg.localModel || 'Local server';
  return webgpuName(cfg.webgpuModel);
}

/** Menu entries for switching model; `refresh` runs after a change. */
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
  entries.push({ separator: true }, { label: 'Model settings…', icon: 'gear', onSelect: openSettings });
  return entries;
}
