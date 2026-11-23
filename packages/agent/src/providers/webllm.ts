import type { MLCEngineInterface } from '@mlc-ai/web-llm';
import type { KernelCore as Kernel } from '../host/os.js';
import type { AgentConfig } from '../config.js';
import { appConfig } from './webllm-store.js';
import { ProviderError, type Block, type Msg, type Provider, type TurnRequest, type TurnResult } from '../types.js';

// One engine (and one multi-gigabyte model in VRAM) is shared by every agent.
let current: { model: string; engine: MLCEngineInterface; pid: number } | null = null;
let loading: Promise<MLCEngineInterface> | null = null;

async function getEngine(os: Kernel, model: string, onStatus: (s: string) => void): Promise<MLCEngineInterface> {
  if (current?.model === model) return current.engine;
  if (loading) await loading.catch(() => undefined);
  if (current && current.model !== model) os.procs.kill(current.pid);
  return (loading = (async () => {
    // The kernel is already a worker, so the engine runs right here on WebGPU.
    const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
    let engineRef: MLCEngineInterface | null = null;
    const proc = os.procs.spawn({
      name: 'webllm',
      kind: 'service',
      detail: `${model} · WebGPU`,
      onKill: () => {
        void engineRef?.unload().catch(() => undefined);
        if (current?.pid === proc.pid) current = null;
      },
    });
    try {
      // The catalogue plus models imported from a folder (Settings → Model).
      const engine = (engineRef = await CreateMLCEngine(model, {
        appConfig: await appConfig(os.settings),
        initProgressCallback: (p) => onStatus(`Loading ${model}: ${p.text}`),
      }));
      current = { model, engine, pid: proc.pid };
      os.procs.update(proc.pid, { state: 'idle' });
      return engine;
    } catch (err) {
      os.procs.kill(proc.pid);
      throw new ProviderError(`Could not load ${model} on WebGPU: ${(err as Error).message}`);
    } finally {
      loading = null;
    }
  })());
}

/**
 * Small local models are unreliable with native function-calling, so tools
 * use a plain-text protocol that any instruct model can follow.
 */
function toolPrompt(req: TurnRequest): string {
  if (!req.tools.length) return req.system;
  const tools = req.tools.map((t) => `- ${t.name}(${Object.keys(t.input_schema.properties ?? {}).join(', ')}): ${t.description.split(/(?<=\.)\s/)[0]}`).join('\n');
  return `${req.system}

# Tools (only when needed)
Most messages need no tool: just answer them. Never ask the user which tool to use. Only when the request needs files, shell commands or running JavaScript, call one of these:
${tools}

To call a tool, reply with only this line:
<tool_call>{"name": "tool_name", "arguments": {"key": "value"}}</tool_call>
The result comes back in a <tool_result> block; then continue, and answer normally when done.`;
}

type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Tokens a message takes, erring high so the prompt never overflows: about
 * 3.4 characters per token for Latin text, one or more per character for
 * Chinese, Japanese, emoji and the like, plus the chat template's own tokens.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3.4 + (text.length - ascii) * 1.2) + 6;
}

/**
 * The conversation in the model's chat format. Only what was said goes back:
 * reasoning (<think>) is dropped, and the oldest turns are left out when the
 * whole thing would not fit the model's small context window.
 */
export function toChat(req: TurnRequest, window = 4096, reserve = 768, fill = 1): ChatMsg[] {
  const system: ChatMsg = { role: 'system', content: toolPrompt(req) };
  const turns: ChatMsg[] = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = turns.at(-1);
    if (last?.role === role) last.content += '\n' + content;
    else turns.push({ role, content });
  };
  for (const m of req.messages as Msg[]) {
    for (const b of m.content) {
      if (b.type === 'text' && b.text) push(m.role, b.text);
      else if (b.type === 'tool_use') push('assistant', `<tool_call>${JSON.stringify({ name: b.name, arguments: b.input })}</tool_call>`);
      else if (b.type === 'tool_result') push('user', `<tool_result>${b.is_error ? 'ERROR: ' : ''}${b.content.slice(0, 2000)}</tool_result>`);
    }
  }
  const budget = Math.floor((window - reserve) * fill) - estimateTokens(system.content);
  let used = turns.reduce((n, t) => n + estimateTokens(t.content), 0);
  // Drop whole exchanges from the front; the newest message always stays.
  while (used > budget && turns.length > 1) {
    const gone = turns.shift()!;
    used -= estimateTokens(gone.content);
    if (turns[0]?.role === 'assistant') used -= estimateTokens(turns.shift()!.content);
  }
  // A single message larger than the window keeps its end.
  while (used > budget && turns[0] && turns[0].content.length > 200) {
    turns[0].content = turns[0].content.slice(Math.ceil(turns[0].content.length / 4));
    used = estimateTokens(turns[0].content);
  }
  return [system, ...turns];
}

export interface ParsedReply {
  thinking: string;
  /** What the person reads: the answer without reasoning or the tool call. */
  text: string;
  call: { name: string; input: Record<string, unknown>; invalid?: string } | null;
}

/** Splits `<think>…</think>` (possibly unfinished) from the answer. */
function splitThinking(full: string): { thinking: string; answer: string; open: boolean } {
  const lead = full.match(/^\s*<think>/);
  if (!lead) return { thinking: '', answer: full, open: false };
  const rest = full.slice(lead[0].length);
  const end = rest.indexOf('</think>');
  return end < 0 ? { thinking: rest, answer: '', open: true } : { thinking: rest.slice(0, end), answer: rest.slice(end + 8).replace(/^\s+/, ''), open: false };
}

function asCall(json: string, known: Set<string> | null): ParsedReply['call'] | 'invalid' | null {
  try {
    const v = JSON.parse(json) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof v?.name !== 'string') return null;
    if (known && !known.has(v.name)) return null;
    const args = v.arguments ?? v.parameters ?? {};
    return { name: v.name, input: (typeof args === 'string' ? JSON.parse(args) : args) as Record<string, unknown> };
  } catch {
    return 'invalid';
  }
}

/**
 * Finds a tool call in what a small model wrote. They are told to use
 * <tool_call>{…}</tool_call>, but often use a ```json block or bare JSON
 * instead; those count only when they name a real tool.
 */
export function parseReply(full: string, tools: string[]): ParsedReply & { at: number } {
  const { thinking, answer } = splitThinking(full);
  const known = new Set(tools);
  const tag = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/.exec(answer);
  if (tag) {
    const c = asCall(tag[1]!, null);
    return { thinking, text: answer.slice(0, tag.index).trim(), call: c === 'invalid' || c === null ? { name: 'unknown', input: {}, invalid: tag[1] } : c, at: tag.index };
  }
  for (const m of answer.matchAll(/```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g)) {
    const c = asCall(m[1]!.trim(), known);
    if (c && c !== 'invalid') return { thinking, text: answer.slice(0, m.index).trim(), call: c, at: m.index! };
  }
  const bare = answer.trim();
  if (bare.startsWith('{') && bare.endsWith('}')) {
    const c = asCall(bare, known);
    if (c && c !== 'invalid') return { thinking, text: '', call: c, at: answer.indexOf('{') };
  }
  return { thinking, text: answer.trim(), call: null, at: -1 };
}

/** Where streaming must pause: anything from here on may turn out to be a tool call. */
function holdFrom(answer: string): number {
  if (/^\s*\{/.test(answer)) return 0;
  const marks = [answer.indexOf('<tool_call'), answer.indexOf('```')].filter((i) => i >= 0);
  // The last few characters may be the start of a marker.
  return Math.min(...marks, Math.max(0, answer.length - 10));
}

/** A model running entirely inside this tab on WebGPU. Nothing leaves the device. */
export async function createWebLlmProvider(os: Kernel, cfg: AgentConfig): Promise<Provider> {
  // Each model has its own window (some 2k, most 4k); the catalogue says which.
  const record = (await appConfig(os.settings)).model_list.find((m) => m.model_id === cfg.webgpuModel);
  const window = record?.overrides?.context_window_size ?? 4096;
  const reserve = Math.min(768, Math.floor(window / 4));
  return {
    id: 'webllm',
    // 0: this provider fits the conversation itself (toChat), leaving reasoning out of the count.
    contextBudget: 0,
    contextWindow: window,
    async turn(req: TurnRequest): Promise<TurnResult> {
      if (!os.hasCap('webgpu')) throw new ProviderError('This browser has no WebGPU, which the in-browser model needs. Choose another provider in Settings → Model.');
      const engine = await getEngine(os, cfg.webgpuModel, req.onStatus);
      req.onStatus('');
      const pid = current?.pid ?? 0;
      os.procs.update(pid, { state: 'running' });
      const started = performance.now();
      const abort = () => engine.interruptGenerate();
      req.signal.addEventListener('abort', abort);
      let full = '';
      let shownThink = 0;
      let shown = 0;
      let finish = '';
      let speed: TurnResult['speed'];
      const usage = { input: 0, output: 0, cacheRead: 0 };
      let chat = toChat(req, window, reserve);
      // Qwen3 thinks out loud by default, which is slow on a phone and eats the small context.
      const noThink = /^qwen3/i.test(cfg.webgpuModel);
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const stream = await engine.chat.completions.create({
              messages: chat,
              stream: true,
              stream_options: { include_usage: true },
              temperature: 0.2,
              max_tokens: reserve,
              ...(noThink ? { extra_body: { enable_thinking: false } } : {}),
            });
            for await (const chunk of stream) {
              const choice = chunk.choices[0];
              full += choice?.delta?.content ?? '';
              if (choice?.finish_reason) finish = choice.finish_reason;
              if (chunk.usage) {
                Object.assign(usage, { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens });
                const x = (chunk.usage as { extra?: { decode_tokens_per_s?: number; time_to_first_token_s?: number } }).extra;
                if (x?.decode_tokens_per_s !== undefined) speed = { tps: x.decode_tokens_per_s, ttft: (x.time_to_first_token_s ?? 0) * 1000 };
              }
              const { thinking, answer } = splitThinking(full);
              if (thinking.length > shownThink) {
                req.onThinking(thinking.slice(shownThink));
                shownThink = thinking.length;
              }
              // Stream prose, but hold back anything that may be the start of a tool call.
              const safe = holdFrom(answer);
              if (safe > shown) {
                req.onText(answer.slice(shown, safe));
                shown = safe;
              }
            }
            break;
          } catch (err) {
            // The estimate was still too small for this text: try once more with much less history.
            if (attempt === 0 && !full && !req.signal.aborted && /context|exceed|too long|kv/i.test((err as Error).message)) {
              chat = toChat(req, window, reserve, 0.6);
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        if (req.signal.aborted) throw req.signal.reason ?? err;
        throw new ProviderError(`The in-browser model failed: ${(err as Error).message}`);
      } finally {
        req.signal.removeEventListener('abort', abort);
        os.procs.account(pid, performance.now() - started);
        os.procs.update(pid, { state: 'idle' });
      }
      req.signal.throwIfAborted();

      // WebLLM keeps the conversation in GPU memory between messages and, when the history
      // matches, only processes the new part: its prompt_tokens then counts just that part.
      // Report the whole prompt, the reused part as "cache read", so the context shown is real.
      // (When nothing was reused, prompt_tokens is the exact total and is used as is.)
      const prompt = chat.reduce((n, m) => n + estimateTokens(m.content), 0);
      usage.cacheRead = usage.input < prompt * 0.8 ? prompt - usage.input : 0;
      const reply = parseReply(full, req.tools.map((t) => t.name));
      const { answer } = splitThinking(full);
      // Show whatever was held back: up to the call, or the rest of the answer.
      const end = reply.call ? reply.at : answer.length;
      if (end > shown) req.onText(answer.slice(shown, end));
      const content: Block[] = [];
      if (reply.thinking.trim()) content.push({ type: 'thinking', text: reply.thinking.trim() });
      if (reply.text) content.push({ type: 'text', text: reply.text });
      if (reply.call) content.push({ type: 'tool_use', id: `local_${Date.now()}`, name: reply.call.name, input: reply.call.input, invalid: reply.call.invalid });
      // Cut off at the output limit: the agent says so (and does not run a half-written tool call).
      const stop = finish === 'length' ? 'max_tokens' : reply.call ? 'tool_use' : 'end';
      return { content, stop, usage, model: cfg.webgpuModel, speed };
    },
  };
}
