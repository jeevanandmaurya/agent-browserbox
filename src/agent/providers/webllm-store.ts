import type { AppConfig, ModelRecord } from '@mlc-ai/web-llm';

/**
 * In-browser (WebGPU) models: what can be downloaded, what is on this device,
 * and models imported from a folder. Weights live in Cache Storage under the
 * same names WebLLM uses ("webllm/model", "webllm/config", "webllm/wasm",
 * keyed by file URL), so anything stored here is what WebLLM loads, and the
 * window and the kernel see the same files.
 */

export const CUSTOM_KEY = 'webllm.custom';
/** Imported models get URLs on this made-up host; they are only ever read from the cache. */
const LOCAL_HOST = 'https://models.browserbox.local';
const CACHE = { model: 'webllm/model', config: 'webllm/config', wasm: 'webllm/wasm' } as const;

/** A model imported from a folder; stored in settings so the kernel can load it. */
export interface CustomModel {
  model_id: string;
  model: string;
  model_lib: string;
  vram_required_MB?: number;
  overrides?: { context_window_size?: number };
}

export interface ModelEntry {
  id: string;
  /** VRAM needed, in MB, as WebLLM reports it. */
  vramMB: number;
  /** Small enough for phones and low-end GPUs. */
  low: boolean;
  custom: boolean;
  /** Shown first: good at following instructions and using tools for their size. */
  recommended: boolean;
  contextWindow: number;
}

interface Settings {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

/** The models worth offering first; everything else is under "Show all". */
const RECOMMENDED = /^(Qwen3-(0\.6|1\.7|4|8)B|Qwen2\.5-Coder-(1\.5|3|7)B-Instruct|Qwen2\.5-(3|7)B-Instruct|Llama-3\.2-(1|3)B-Instruct|Llama-3\.1-8B-Instruct|Phi-4-mini-instruct|Hermes-3-Llama-3\.(1-8|2-3)B|gemma3-1b-it|SmolLM2-(360M|1\.7B)-Instruct|Mistral-7B-Instruct-v0\.3)-q4f16_1-MLC$/;

export async function appConfig(settings: Settings): Promise<AppConfig> {
  const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
  const custom = settings.get<CustomModel[]>(CUSTOM_KEY, []);
  // Imported models first: WebLLM uses the first record with a matching id.
  const ids = new Set(custom.map((m) => m.model_id));
  return { ...prebuiltAppConfig, model_list: [...(custom as ModelRecord[]), ...prebuiltAppConfig.model_list.filter((m) => !ids.has(m.model_id))] };
}

export async function catalogue(settings: Settings): Promise<ModelEntry[]> {
  const cfg = await appConfig(settings);
  const custom = new Set(settings.get<CustomModel[]>(CUSTOM_KEY, []).map((m) => m.model_id));
  return cfg.model_list
    .filter((m) => custom.has(m.model_id) || (!/vision|-1k$|q0f|q4f32/i.test(m.model_id) && (m.model_type === undefined || m.model_type === 0)))
    .map((m) => ({
      id: m.model_id,
      vramMB: Math.round(m.vram_required_MB ?? 0),
      low: !!m.low_resource_required,
      custom: custom.has(m.model_id),
      recommended: custom.has(m.model_id) || RECOMMENDED.test(m.model_id),
      contextWindow: m.overrides?.context_window_size ?? 4096,
    }))
    .sort((a, b) => Number(b.custom) - Number(a.custom) || a.vramMB - b.vramMB);
}

/** https://huggingface.co/u/m → https://huggingface.co/u/m/resolve/main/ (as WebLLM does). */
function baseUrl(model: string): string {
  let u = model.endsWith('/') ? model : `${model}/`;
  if (!/.+\/resolve\/.+\//.test(u)) u += 'resolve/main/';
  return new URL(u).href;
}

async function record(settings: Settings, id: string): Promise<ModelRecord> {
  const r = (await appConfig(settings)).model_list.find((m) => m.model_id === id);
  if (!r) throw new Error(`unknown model: ${id}`);
  return r;
}

/** Whether every file the model needs is on this device. */
export async function isDownloaded(settings: Settings, id: string): Promise<boolean> {
  const r = await record(settings, id);
  const base = baseUrl(r.model);
  const [model, config, wasm] = await Promise.all([caches.open(CACHE.model), caches.open(CACHE.config), caches.open(CACHE.wasm)]);
  const manifest = await model.match(new URL('tensor-cache.json', base).href);
  if (!manifest || !(await config.match(new URL('mlc-chat-config.json', base).href)) || !(await wasm.match(r.model_lib))) return false;
  const list = ((await manifest.json()) as { records: Array<{ dataPath: string }> }).records;
  const keys = new Set((await model.keys()).map((k) => k.url));
  return list.every((rec) => keys.has(new URL(rec.dataPath, base).href));
}

export async function downloadedIds(settings: Settings, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(ids.map(async (id) => (await isDownloaded(settings, id).catch(() => false)) && out.add(id)));
  return out;
}

/** Downloads a model's weights, tokenizer, config and GPU library, reporting bytes. */
export async function download(settings: Settings, id: string, progress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  const r = await record(settings, id);
  const base = baseUrl(r.model);
  const [model, config, wasm] = await Promise.all([caches.open(CACHE.model), caches.open(CACHE.config), caches.open(CACHE.wasm)]);
  const get = async (cache: Cache, url: string): Promise<Response> => {
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await cache.put(url, res.clone());
    return res;
  };
  const cfg = (await (await get(config, new URL('mlc-chat-config.json', base).href)).json()) as { tokenizer_files?: string[] };
  const manifest = (await (await get(model, new URL('tensor-cache.json', base).href)).json()) as { records: Array<{ dataPath: string; nbytes: number }> };
  const total = manifest.records.reduce((n, rec) => n + rec.nbytes, 0);
  let loaded = 0;
  progress(0, total);
  for (const rec of manifest.records) {
    const url = new URL(rec.dataPath, base).href;
    if (!(await model.match(url))) {
      // Streamed so the bar moves within a shard, then stored whole.
      const res = await fetch(url, { signal });
      if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (const reader = res.body.getReader(); ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        progress(loaded + got, total);
      }
      await model.put(url, new Response(new Blob(chunks as BlobPart[]), { headers: { 'content-type': 'application/octet-stream' } }));
    }
    loaded += rec.nbytes;
    progress(loaded, total);
  }
  for (const f of cfg.tokenizer_files ?? []) await get(model, new URL(f, base).href);
  await get(wasm, r.model_lib);
}

/** Deletes a model's files; an imported model is also forgotten. */
export async function remove(settings: Settings, id: string): Promise<void> {
  const r = await record(settings, id);
  const base = baseUrl(r.model);
  const [model, config, wasm] = await Promise.all([caches.open(CACHE.model), caches.open(CACHE.config), caches.open(CACHE.wasm)]);
  for (const k of await model.keys()) if (k.url.startsWith(base)) await model.delete(k);
  for (const k of await config.keys()) if (k.url.startsWith(base)) await config.delete(k);
  // Several models share one GPU library: keep it while another downloaded model needs it.
  const others = (await appConfig(settings)).model_list.filter((m) => m.model_id !== id && m.model_lib === r.model_lib);
  const shared = await Promise.all(others.map((m) => model.match(new URL('tensor-cache.json', baseUrl(m.model)).href)));
  if (!shared.some(Boolean)) await wasm.delete(r.model_lib);
  const custom = settings.get<CustomModel[]>(CUSTOM_KEY, []);
  if (custom.some((m) => m.model_id === id)) settings.set(CUSTOM_KEY, custom.filter((m) => m.model_id !== id));
}

/**
 * Imports an MLC-compiled model from a folder on the computer: the folder that
 * holds mlc-chat-config.json, tensor-cache.json (or ndarray-cache.json), the
 * params shards and tokenizer, plus the model's WebGPU library (.wasm).
 */
export async function importFolder(settings: Settings, files: File[], progress?: (loaded: number, total: number) => void): Promise<string> {
  const byName = new Map<string, File>();
  for (const f of files) byName.set((f.webkitRelativePath || f.name).split('/').pop()!, f);
  const config = byName.get('mlc-chat-config.json');
  const manifest = byName.get('tensor-cache.json') ?? byName.get('ndarray-cache.json');
  const lib = files.find((f) => f.name.endsWith('.wasm'));
  const missing = [!config && 'mlc-chat-config.json', !manifest && 'tensor-cache.json (or ndarray-cache.json)', !lib && 'the model library (.wasm)'].filter(Boolean);
  if (missing.length) throw new Error(`This folder is not an MLC model for the browser: it has no ${missing.join(', ')}. Compile one with mlc_llm (see llm.mlc.ai/docs/deploy/webllm).`);
  const folder = (files[0]!.webkitRelativePath || '').split('/')[0] || lib!.name.replace(/\.wasm$/, '');
  const cfg = JSON.parse(await config!.text()) as { model_id?: string; context_window_size?: number };
  let id = (cfg.model_id || folder).replace(/[^\w.-]+/g, '-');
  // Never shadow a catalogue model: the imported files would be ignored for the download.
  const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
  if (prebuiltAppConfig.model_list.some((m) => m.model_id === id)) id = `${id}-local`;
  const model = `${LOCAL_HOST}/${encodeURIComponent(id)}`;
  const base = baseUrl(model);
  const model_lib = `${LOCAL_HOST}/${encodeURIComponent(id)}/${encodeURIComponent(lib!.name)}`;
  const [mCache, cCache, wCache] = await Promise.all([caches.open(CACHE.model), caches.open(CACHE.config), caches.open(CACHE.wasm)]);
  const total = files.reduce((n, f) => n + f.size, 0);
  let loaded = 0;
  const put = async (cache: Cache, url: string, f: File) => {
    await cache.put(url, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
    loaded += f.size;
    progress?.(loaded, total);
  };
  for (const [name, f] of byName) {
    if (name.endsWith('.wasm')) continue;
    if (name === 'mlc-chat-config.json') await put(cCache, new URL(name, base).href, f);
    else if (name === 'ndarray-cache.json') await put(mCache, new URL('tensor-cache.json', base).href, f);
    else await put(mCache, new URL(name, base).href, f);
  }
  await put(wCache, model_lib, lib!);
  const entry: CustomModel = { model_id: id, model, model_lib, overrides: cfg.context_window_size ? { context_window_size: cfg.context_window_size } : undefined };
  settings.set(CUSTOM_KEY, [...settings.get<CustomModel[]>(CUSTOM_KEY, []).filter((m) => m.model_id !== id), entry]);
  return id;
}
