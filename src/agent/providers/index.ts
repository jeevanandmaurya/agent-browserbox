import type { KernelCore as Kernel } from '@/kernel/kernel';
import { SECRET, type AgentConfig } from '../config';
import { ProviderError, type Provider } from '../types';

/** Builds the configured provider. Each adapter is code-split, so only the one in use is downloaded. */
export async function createProvider(os: Kernel, cfg: AgentConfig): Promise<Provider> {
  if (cfg.provider === 'anthropic') {
    const key = await os.secrets.get(SECRET.anthropic);
    if (!key) throw new ProviderError('No Anthropic API key yet. Add one in Settings → Model, or switch to a local model there.');
    return (await import('./anthropic')).createAnthropicProvider(cfg, key, await os.mcp.relayed());
  }
  if (cfg.provider === 'openai') return (await import('./openai')).createOpenAiProvider(cfg, await os.secrets.get(SECRET.openai));
  return (await import('./webllm')).createWebLlmProvider(os, cfg);
}
