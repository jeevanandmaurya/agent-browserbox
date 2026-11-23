import type { Kernel, WithFiles, WithSettings } from './host/os.js';

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
  /**
   * A relay for hosted APIs that do not accept requests from web pages (no CORS),
   * e.g. ollama.com. Requests go to `<relay>/<full API URL>`; see relay/worker.js.
   */
  corsRelay: string;
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
  corsRelay: '',
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
  { label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', hint: 'ollama.com does not accept requests from web pages, so it needs a relay (below). Or use Local server instead: a local Ollama signed in to your account (ollama signin) runs the -cloud models for you.' },
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

export function loadConfig(os: WithSettings): AgentConfig {
  const stored = os.settings.get<Partial<AgentConfig>>(KEY, {});
  // Older configs kept local servers under the "openai" provider; move them across.
  if (stored.provider === 'openai' && stored.localBaseUrl === undefined && stored.openaiBaseUrl && isLocalUrl(stored.openaiBaseUrl)) {
    return { ...DEFAULT_CONFIG, ...stored, provider: 'local', localBaseUrl: stored.openaiBaseUrl, localModel: stored.openaiModel ?? '', openaiBaseUrl: DEFAULT_CONFIG.openaiBaseUrl, openaiModel: '' };
  }
  return { ...DEFAULT_CONFIG, ...stored };
}

export function saveConfig(os: WithSettings, patch: Partial<AgentConfig>): AgentConfig {
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

/** The URL to request, through the relay when one is set. */
export function relayed(url: string, relay = ''): string {
  return relay.trim() ? `${relay.trim().replace(/\/+$/, '')}/${url}` : url;
}

/** Why a browser could not reach a server, and what to do about it. */
export function unreachable(url: string, kind: 'local' | 'openai', relay = ''): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw text */
  }
  if (relay.trim()) return `Could not reach ${host} through the relay ${relay}. Check that the relay is running and allows ${host}.`;
  if (kind === 'local') return `Could not reach ${host}. Is the server running, and does it allow this page's origin (CORS)? For Ollama: OLLAMA_ORIGINS="*" ollama serve`;
  const ollama = /(^|\.)ollama\.com$/.test(host)
    ? ' For Ollama Cloud you can instead run Ollama on your computer, sign in (ollama signin) and use Local server: it runs the -cloud models for you.'
    : '';
  return `${host} did not accept a request from this page. Browsers only let a web page call servers that allow it (CORS), and ${host} does not (or the address is wrong, or you are offline). Set a relay in Settings → Model → OpenAI-compatible API (relay/worker.js in the BrowserBox repository is one you can deploy for free), or use a provider that allows browser requests, such as OpenRouter.${ollama}`;
}

/** Lists model ids from an OpenAI-compatible server. Throws with a readable message when unreachable. */
export async function probeOpenAi(baseUrl: string, apiKey?: string | null, signal?: AbortSignal, opts: { kind?: 'local' | 'openai'; relay?: string } = {}): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(relayed(`${baseUrl.replace(/\/+$/, '')}/models`, opts.relay), { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal });
  } catch {
    throw new Error(unreachable(baseUrl, opts.kind ?? 'local', opts.relay));
  }
  if (!res.ok) throw new Error(`${baseUrl} answered ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id).sort();
}
