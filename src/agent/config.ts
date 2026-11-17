import type { Kernel } from '@/kernel/api';

export type ProviderId = 'anthropic' | 'openai' | 'webllm';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentConfig {
  provider: ProviderId;
  /** Claude model id (Anthropic API). */
  anthropicModel: string;
  effort: Effort;
  /** Base URL of an OpenAI-compatible server, e.g. a local Ollama. */
  openaiBaseUrl: string;
  openaiModel: string;
  /** MLC model id for the in-browser WebGPU runtime. */
  webllmModel: string;
  /** Upper bound on model↔tool round trips per user message. */
  maxSteps: number;
  /** Extra instructions appended to the system prompt. */
  instructions: string;
  /** Let Claude use Anthropic's server-side web search and fetch tools. */
  webSearch: boolean;
  /** Context window of the local/OpenAI-compatible model, in tokens (the server does not report it). */
  contextWindow: number;
  /** Summarise the conversation automatically when the context is nearly full. */
  autoCompact: boolean;
}

export const DEFAULT_CONFIG: AgentConfig = {
  provider: 'anthropic',
  anthropicModel: 'claude-opus-5-5',
  effort: 'medium',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiModel: '',
  webllmModel: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
  maxSteps: 50,
  instructions: '',
  webSearch: true,
  contextWindow: 32768,
  autoCompact: true,
};

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — default executor' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 — most capable' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — fast, balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest' },
] as const;

/** Local servers that speak the OpenAI chat-completions protocol. */
export const LOCAL_PRESETS = [
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', hint: 'Start with OLLAMA_ORIGINS="*" ollama serve so the browser may connect.' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', hint: 'Enable CORS in the LM Studio server settings.' },
  { label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1', hint: 'Run llama-server (CORS is enabled by default).' },
  { label: 'vLLM', baseUrl: 'http://localhost:8000/v1', hint: 'Pass --allowed-origins \'["*"]\' to the server.' },
] as const;

/** Models that run fully inside this tab on WebGPU (weights are cached after the first download). */
export const WEBLLM_MODELS = [
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 Coder 1.5B — ~1.5 GB VRAM' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B — ~2.5 GB VRAM' },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 mini — ~3.7 GB VRAM' },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 7B — ~5 GB VRAM' },
  { id: 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC', label: 'Hermes 3 Llama 3.1 8B — ~5 GB VRAM' },
] as const;

/** Names under which API keys are kept in the encrypted secret store (`os.secrets`). */
export const SECRET = { anthropic: 'anthropic.apiKey', openai: 'openai.apiKey' } as const;

const KEY = 'agent.config';

export function loadConfig(os: Kernel): AgentConfig {
  return { ...DEFAULT_CONFIG, ...os.settings.get<Partial<AgentConfig>>(KEY, {}) };
}

export function saveConfig(os: Kernel, patch: Partial<AgentConfig>): AgentConfig {
  const next = { ...loadConfig(os), ...patch };
  os.settings.set(KEY, next);
  return next;
}

/** Human label for the active model, e.g. for window titles. */
export function describeModel(cfg: AgentConfig): string {
  if (cfg.provider === 'anthropic') return cfg.anthropicModel;
  if (cfg.provider === 'openai') return `${cfg.openaiModel || 'no model'} @ ${cfg.openaiBaseUrl.replace(/^https?:\/\//, '')}`;
  return `${cfg.webllmModel} (WebGPU)`;
}

/** Lists model ids from an OpenAI-compatible server. Throws with a readable message when unreachable. */
export async function probeOpenAi(baseUrl: string, apiKey?: string | null, signal?: AbortSignal): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal });
  } catch {
    throw new Error(`Could not reach ${baseUrl}. Is the server running, and does it allow this page's origin (CORS)?`);
  }
  if (!res.ok) throw new Error(`${baseUrl} answered ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id).sort();
}
