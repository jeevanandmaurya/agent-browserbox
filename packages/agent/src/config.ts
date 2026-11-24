import type { Kernel, WithFiles, WithSettings } from './host/os.js';

/**
 * Where the agent's model runs. api: a hosted model with an API key (Anthropic,
 * OpenAI, OpenRouter, Groq…). local: a model server on your own machine or
 * network (Ollama, LM Studio…). webgpu: a model in this tab.
 */
export type ProviderId = 'api' | 'local' | 'webgpu' | 'builtin';
/** The wire protocol of an API: Anthropic's own for api.anthropic.com, OpenAI-compatible for everything else. */
export type Protocol = 'anthropic' | 'openai';

export interface AgentConfig {
  provider: ProviderId;
  /** A hosted API: base URL (ending in /v1) and model id. */
  apiBaseUrl: string;
  apiModel: string;
  /** A model server on your machine or network. */
  localBaseUrl: string;
  localModel: string;
  /** MLC model id for the in-browser WebGPU runtime. */
  webgpuModel: string;
  /** Model id for sub-agents on an API ('' = the main model). Custom agents can name their own. */
  subagentModel: string;
  /** Upper bound on model↔tool round trips per user message. */
  maxSteps: number;
  /** Extra instructions appended to the system prompt. */
  instructions: string;
  /** Context window of models that do not report it, in tokens. */
  contextWindow: number;
  /** Summarise the conversation automatically when the context is nearly full. */
  autoCompact: boolean;
  /**
   * A relay for hosted APIs that do not accept requests from web pages (no CORS),
   * e.g. ollama.com. Requests go to `<relay>/<full API URL>`; see relay/worker.js.
   */
  corsRelay: string;
  /**
   * Web search for models without their own (everything but Anthropic's API):
   * a service with your key, Wikipedia only, or none. 'auto': the first service
   * with a key saved, else Wikipedia.
   */
  webSearch: WebSearchService;
  /** web_fetch may read pages that refuse web pages through Jina Reader (r.jina.ai), which then sees their address. */
  jinaReader: boolean;
  /** The host an API key saved before 0.3 (one key for every OpenAI-compatible API) belongs to. */
  legacyKeyHost?: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  provider: 'api',
  apiBaseUrl: 'https://api.anthropic.com/v1',
  apiModel: 'claude-opus-5-5',
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: '',
  webgpuModel: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
  subagentModel: '',
  maxSteps: 50,
  instructions: '',
  contextWindow: 32768,
  autoCompact: true,
  corsRelay: '',
  webSearch: 'auto',
  jinaReader: true,
};

export type WebSearchService = 'auto' | 'tavily' | 'serper' | 'jina' | 'wikipedia' | 'off';

/** Search services the browser may call (they allow web pages), with where their keys are kept. */
export const SEARCH_SERVICES = [
  { id: 'tavily', name: 'Tavily', secret: 'search.tavily', site: 'https://tavily.com', hint: 'Made for AI agents: results with page excerpts. Free tier.' },
  { id: 'serper', name: 'Serper (Google results)', secret: 'search.serper', site: 'https://serper.dev', hint: 'Google’s results. Free tier.' },
  { id: 'jina', name: 'Jina Search', secret: 'search.jina', site: 'https://jina.ai', hint: 'The same key also raises Jina Reader’s rate limit.' },
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
  { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', hint: 'Claude models. Keys at console.anthropic.com. Includes web search and fetch.', model: 'claude-opus-5-5' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hint: 'Keys at platform.openai.com.' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'One key for many models; allows browser requests.' },
  { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hint: 'Gemini models. Keys at aistudio.google.com. Allows browser requests.' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', hint: 'Fast open models.' },
  { label: 'Together', baseUrl: 'https://api.together.xyz/v1', hint: 'Open models.' },
  { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', hint: 'Mistral models.' },
  { label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', hint: 'ollama.com does not accept requests from web pages, so it needs a relay (below). Or use Local server instead: a local Ollama signed in to your account (ollama signin) runs the -cloud models for you.' },
] as const;

/** Names under which API keys are kept in the encrypted secret store (`os.secrets`): one per API host. */
export const SECRET = {
  local: 'local.apiKey',
  api: (baseUrl: string): string => `api.key:${hostOf(baseUrl)}`,
} as const;

/** Keys stored before keys were kept per host. */
const LEGACY_KEY = { anthropic: 'anthropic.apiKey', openai: 'openai.apiKey' } as const;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.trim();
  }
}

/** Which protocol an API speaks, from its address. */
export function protocolOf(baseUrl: string): Protocol {
  return /(^|\.)anthropic\.com$/.test(new URL(baseUrl, 'https://x').hostname) ? 'anthropic' : 'openai';
}

interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete?(name: string): Promise<void>;
}

/** The old key name that belongs to this API, if any: never a key saved for another host. */
function legacyName(baseUrl: string, legacyHost = 'api.openai.com'): string | null {
  const host = hostOf(baseUrl);
  if (host === 'api.anthropic.com') return LEGACY_KEY.anthropic;
  return host === legacyHost ? LEGACY_KEY.openai : null;
}

/** The API key for an API, moving a key saved under its older name across. */
export async function apiKeyFor(secrets: SecretStore, baseUrl: string, legacyHost?: string): Promise<string | null> {
  const name = SECRET.api(baseUrl);
  const key = await secrets.get(name);
  if (key) return key;
  const old = legacyName(baseUrl, legacyHost);
  const legacy = old ? await secrets.get(old) : null;
  if (legacy) await secrets.set(name, legacy);
  return legacy;
}

/** Moves keys saved before 0.3 to their per-host names and deletes the old names. */
export async function migrateKeys(os: WithSettings & { secrets: SecretStore }): Promise<void> {
  const cfg = loadConfig(os);
  const moves: Array<[string, string]> = [
    [LEGACY_KEY.anthropic, 'https://api.anthropic.com/v1'],
    [LEGACY_KEY.openai, `https://${cfg.legacyKeyHost ?? 'api.openai.com'}/v1`],
  ];
  for (const [old, url] of moves) {
    const value = await os.secrets.get(old);
    if (!value) continue;
    if (!(await os.secrets.get(SECRET.api(url)))) await os.secrets.set(SECRET.api(url), value);
    await os.secrets.delete?.(old);
  }
}

/** Whether the model can use the API's own server-side web search and fetch. */
export function hasServerWebTools(cfg: AgentConfig): boolean {
  return cfg.provider === 'api' && protocolOf(cfg.apiBaseUrl) === 'anthropic';
}

/** web_search and web_fetch run in the browser: every model but those with server-side web tools. */
export const hasBrowserWebTools = (cfg: AgentConfig): boolean => !hasServerWebTools(cfg) && (cfg.webSearch ?? 'auto') !== 'off';

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
  return migrate(os.settings.get<Record<string, unknown>>(KEY, {}));
}

/** Reads a stored config, including the shapes older versions saved. */
export function migrate(stored: Record<string, unknown>): AgentConfig {
  const str = (k: string) => (typeof stored[k] === 'string' ? (stored[k] as string) : undefined);
  const cfg: AgentConfig = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as Array<keyof AgentConfig>) if (stored[k] !== undefined && typeof stored[k] === typeof DEFAULT_CONFIG[k]) (cfg as unknown as Record<string, unknown>)[k] = stored[k];
  // Before 0.3: providers anthropic | openai | local | webllm, each with its own fields.
  const old = str('provider');
  if (str('webllmModel') && stored.webgpuModel === undefined) cfg.webgpuModel = str('webllmModel')!;
  if (old === 'webllm') cfg.provider = 'webgpu';
  if (old === 'anthropic' || (old !== 'openai' && stored.apiBaseUrl === undefined && str('anthropicModel'))) {
    if (old === 'anthropic') cfg.provider = 'api';
    cfg.apiBaseUrl = 'https://api.anthropic.com/v1';
    cfg.apiModel = str('anthropicModel') ?? DEFAULT_CONFIG.apiModel;
  }
  if (old === 'openai') {
    const url = str('openaiBaseUrl') ?? 'https://api.openai.com/v1';
    // Even older configs kept local servers under "openai".
    if (stored.localBaseUrl === undefined && isLocalUrl(url)) Object.assign(cfg, { provider: 'local', localBaseUrl: url, localModel: str('openaiModel') ?? '' });
    else Object.assign(cfg, { provider: 'api', apiBaseUrl: url, apiModel: str('openaiModel') ?? '' });
  }
  if (!['api', 'local', 'webgpu', 'builtin'].includes(cfg.provider)) cfg.provider = DEFAULT_CONFIG.provider;
  const keyHost = str('legacyKeyHost') ?? (str('openaiBaseUrl') ? hostOf(str('openaiBaseUrl')!) : undefined);
  if (keyHost) cfg.legacyKeyHost = keyHost;
  return cfg;
}

export function saveConfig(os: WithSettings, patch: Partial<AgentConfig>): AgentConfig {
  const next = { ...loadConfig(os), ...patch };
  os.settings.set(KEY, next);
  return next;
}

/** Human label for the active model, e.g. for window titles. */
export function describeModel(cfg: AgentConfig): string {
  if (cfg.provider === 'local') return `${cfg.localModel || 'no model'} @ ${hostOf(cfg.localBaseUrl)}`;
  if (cfg.provider === 'api') return `${cfg.apiModel || 'no model'} @ ${hostOf(cfg.apiBaseUrl)}`;
  if (cfg.provider === 'builtin') return 'Built into this browser';
  return `${cfg.webgpuModel} (WebGPU)`;
}

/**
 * The address to use for an API: a few well-known services answer the
 * OpenAI-compatible protocol only under a longer path than people type.
 */
export function apiBase(url: string): string {
  const base = url.trim().replace(/\/+$/, '');
  try {
    const u = new URL(base);
    // Google: the OpenAI-compatible endpoint is /v1beta/openai (anything else answers 404, which a browser reports as CORS).
    if (u.hostname === 'generativelanguage.googleapis.com' && !/\/openai$/.test(u.pathname)) return `${u.origin}/v1beta/openai`;
  } catch {
    /* not a URL: leave it */
  }
  return base;
}

/** The URL to request, through the relay when one is set. */
export function relayed(url: string, relay = ''): string {
  return relay.trim() ? `${relay.trim().replace(/\/+$/, '')}/${url}` : url;
}

/** Why a browser could not reach a server, and what to do about it. */
export function unreachable(url: string, kind: 'local' | 'api', relay = ''): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw text */
  }
  if (relay.trim()) return `Could not reach ${host} through the relay ${relay}. Check that the relay is running and allows ${host}.`;
  if (kind === 'local') return `Could not reach ${host}. Is the server running, and does it allow this page's origin (CORS)? For Ollama: OLLAMA_ORIGINS="*" ollama serve`;
  // Services that do accept browser requests: then the address is the likely problem.
  const open: Record<string, string> = { 'generativelanguage.googleapis.com': 'https://generativelanguage.googleapis.com/v1beta/openai', 'openrouter.ai': 'https://openrouter.ai/api/v1', 'api.anthropic.com': 'https://api.anthropic.com/v1' };
  if (open[host]) return `${host} did not answer this address: ${url}. It does accept requests from web pages, so check the address in Settings → Model → API (it should be ${open[host]}), the model name, and that you are online.`;
  const ollama = /(^|\.)ollama\.com$/.test(host)
    ? ' For Ollama Cloud you can instead run Ollama on your computer, sign in (ollama signin) and use Local server: it runs the -cloud models for you.'
    : '';
  return `${host} did not accept a request from this page. Browsers only let a web page call servers that allow it (CORS), and ${host} does not (or the address is wrong, or you are offline). Set a relay in Settings → Model → API: one on your computer (node relay/local.mjs from the BrowserBox repository, then http://localhost:8787) or one you deploy for free (relay/worker.js), or use a provider that allows browser requests, such as OpenRouter.${ollama}`;
}

/** Lists model ids from an API or model server. Throws with a readable message when unreachable. */
export async function probeModels(baseUrl: string, apiKey?: string | null, signal?: AbortSignal, opts: { kind?: 'local' | 'api'; relay?: string } = {}): Promise<string[]> {
  const anthropic = opts.kind === 'api' && protocolOf(baseUrl) === 'anthropic';
  const headers: Record<string, string> = !apiKey ? {} : anthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : { authorization: `Bearer ${apiKey}` };
  let res: Response;
  try {
    res = await fetch(relayed(`${opts.kind === 'api' ? apiBase(baseUrl) : baseUrl.replace(/\/+$/, '')}/models${anthropic ? '?limit=100' : ''}`, anthropic ? '' : opts.relay), { headers, signal });
  } catch {
    throw new Error(unreachable(baseUrl, opts.kind ?? 'local', opts.relay));
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${hostOf(baseUrl)} rejected the API key (${res.status}).`);
  if (!res.ok) throw new Error(`${baseUrl} answered ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id).sort();
}

/** @deprecated Use probeModels. */
export const probeOpenAi = probeModels;
