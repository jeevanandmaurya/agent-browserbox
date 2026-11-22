import type { KernelCore as Kernel } from '../host/os.js';
import { SECRET, type AgentConfig } from '../config.js';
import { ProviderError, type Provider } from '../types.js';

/** Builds the configured provider. Each adapter is code-split, so only the one in use is downloaded. */
export async function createProvider(os: Kernel, cfg: AgentConfig): Promise<Provider> {
  const custom = os.customProvider();
  if (custom) return custom;
  if (cfg.provider === 'anthropic') {
    const key = await os.secrets.get(SECRET.anthropic);
    if (!key) throw new ProviderError('No Anthropic API key yet. Add one in Settings → Model, or switch to a local model there.');
    return (await import('./anthropic.js')).createAnthropicProvider(cfg, key, await os.mcp.relayed());
  }
  if (cfg.provider === 'local') return (await import('./openai.js')).createOpenAiProvider(cfg, { kind: 'local', baseUrl: cfg.localBaseUrl, model: cfg.localModel }, await os.secrets.get(SECRET.local));
  if (cfg.provider === 'openai') {
    const key = await os.secrets.get(SECRET.openai);
    if (!key) throw new ProviderError('No API key for the OpenAI-compatible API yet. Add one in Settings → Model.');
    return (await import('./openai.js')).createOpenAiProvider(cfg, { kind: 'openai', baseUrl: cfg.openaiBaseUrl, model: cfg.openaiModel }, key);
  }
  return (await import('./webllm.js')).createWebLlmProvider(os, cfg);
}
