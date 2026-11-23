import type { KernelCore as Kernel } from '../host/os.js';
import { apiKeyFor, protocolOf, SECRET, type AgentConfig } from '../config.js';
import { ProviderError, type Provider } from '../types.js';

/** Builds the configured provider. Each adapter is code-split, so only the one in use is downloaded. */
export async function createProvider(os: Kernel, cfg: AgentConfig): Promise<Provider> {
  const custom = os.customProvider();
  if (custom) return custom;
  if (cfg.provider === 'api') {
    const key = await apiKeyFor(os.secrets, cfg.apiBaseUrl);
    if (!key) throw new ProviderError('No API key yet. Add one in Settings → Model, or choose a local server or an in-browser model there.');
    if (protocolOf(cfg.apiBaseUrl) === 'anthropic') return (await import('./anthropic.js')).createAnthropicProvider(cfg, key, await os.mcp.relayed());
    return (await import('./openai.js')).createOpenAiProvider(cfg, { kind: 'api', baseUrl: cfg.apiBaseUrl, model: cfg.apiModel }, key);
  }
  if (cfg.provider === 'local') return (await import('./openai.js')).createOpenAiProvider(cfg, { kind: 'local', baseUrl: cfg.localBaseUrl, model: cfg.localModel }, await os.secrets.get(SECRET.local));
  return (await import('./webllm.js')).createWebLlmProvider(os, cfg);
}
