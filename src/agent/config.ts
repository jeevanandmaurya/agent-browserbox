import type { Kernel } from '@/kernel/api';

/**
 * anthropic: Claude via Anthropic's API. local: a model server on your own
 * machine or network (Ollama, LM Studio…). openai: a hosted API that speaks
 * the OpenAI protocol (OpenAI, OpenRouter, Groq…). webllm: a model in this tab.
 */
export type ProviderId = 'anthropic' | 'local' | 'openai' | 'webllm';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentConfig {
  provider: ProviderId;
  /** Claude model id (Anthropic API). */
  anthropicModel: string;
  effort: Effort;
  /** A model server on your machine or network. */
  localBaseUrl: string;
  localModel: string;
  /** A hosted OpenAI-compatible API. */
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
  /** Context window of a local or OpenAI-compatible model, in tokens (servers do not report it). */
  contextWindow: number;
  /** Summarise the conversation automatically when the context is nearly full. */
  autoCompact: boolean;
}

export const DEFAULT_CONFIG: AgentConfig = {
  provider: 'anthropic',
  anthropicModel: 'claude-opus-5-5',
  effort: 'medium',
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
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

/** Model servers you run yourself; they speak the OpenAI chat-completions protocol. */
export const LOCAL_PRESETS = [
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', hint: 'Start with OLLAMA_ORIGINS="*" ollama serve so the browser may connect.' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', hint: 'Enable CORS in the LM Studio server settings.' },
  { label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1', hint: 'Run llama-server (CORS is enabled by default).' },
  { label: 'vLLM', baseUrl: 'http://localhost:8000/v1', hint: 'Pass --allowed-origins \'["*"]\' to the server.' },
] as const;

/** Hosted APIs that speak the OpenAI protocol. They need an API key and must allow browser (CORS) requests. */
export const API_PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hint: 'Keys at platform.openai.com.' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'One key for many models; allows browser requests.' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', hint: 'Fast open models.' },
  { label: 'Together', baseUrl: 'https://api.together.xyz/v1', hint: 'Open models.' },
  { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', hint: 'Mistral models.' },
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
export const SECRET = { anthropic: 'anthropic.apiKey', openai: 'openai.apiKey', local: 'local.apiKey' } as const;

const KEY = 'agent.config';

const isLocalUrl = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h) || h.endsWith('.local');
  } catch {
    return false;
  }
};

export function loadConfig(os: Kernel): AgentConfig {
  const stored = os.settings.get<Partial<AgentConfig>>(KEY, {});
  // Older configs kept local servers under the "openai" provider; move them across.
  if (stored.provider === 'openai' && stored.localBaseUrl === undefined && stored.openaiBaseUrl && isLocalUrl(stored.openaiBaseUrl)) {
    return { ...DEFAULT_CONFIG, ...stored, provider: 'local', localBaseUrl: stored.openaiBaseUrl, localModel: stored.openaiModel ?? '', openaiBaseUrl: DEFAULT_CONFIG.openaiBaseUrl, openaiModel: '' };
  }
  return { ...DEFAULT_CONFIG, ...stored };
}

export function saveConfig(os: Kernel, patch: Partial<AgentConfig>): AgentConfig {
  const next = { ...loadConfig(os), ...patch };
  os.settings.set(KEY, next);
  return next;
}

/** Human label for the active model, e.g. for window titles. */
export function describeModel(cfg: AgentConfig): string {
  if (cfg.provider === 'anthropic') return cfg.anthropicModel;
  if (cfg.provider === 'local') return `${cfg.localModel || 'no model'} @ ${cfg.localBaseUrl.replace(/^https?:\/\//, '')}`;
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
