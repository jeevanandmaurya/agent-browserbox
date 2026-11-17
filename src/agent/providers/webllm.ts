import type { MLCEngineInterface } from '@mlc-ai/web-llm';
import type { KernelCore as Kernel } from '@/kernel/kernel';
import type { AgentConfig } from '../config';
import { ProviderError, type Block, type Msg, type Provider, type TurnRequest, type TurnResult } from '../types';

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
      const engine = (engineRef = await CreateMLCEngine(model, {
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
  const tools = req.tools.map((t) => `- ${t.name}: ${t.description.split('\n')[0]} Arguments: ${JSON.stringify(t.input_schema.properties)}`).join('\n');
  return `${req.system}

# Tools
You can call these tools:
${tools}

To call a tool, reply with exactly this and nothing after it:
<tool_call>{"name": "tool_name", "arguments": {"key": "value"}}</tool_call>
You will then receive the result in a <tool_result> block. Call one tool at a time. When the task is done, answer normally without a tool call.`;
}

function toChat(req: TurnRequest): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: toolPrompt(req) }];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = out.at(-1)!;
    if (last.role === role) last.content += '\n' + content;
    else out.push({ role, content });
  };
  for (const m of req.messages as Msg[]) {
    for (const b of m.content) {
      if (b.type === 'text' && b.text) push(m.role, b.text);
      else if (b.type === 'tool_use') push('assistant', `<tool_call>${JSON.stringify({ name: b.name, arguments: b.input })}</tool_call>`);
      else if (b.type === 'tool_result') push('user', `<tool_result>${b.is_error ? 'ERROR: ' : ''}${b.content.slice(0, 3000)}</tool_result>`);
    }
  }
  return out;
}

/** A model running entirely inside this tab on WebGPU. Nothing leaves the device. */
export function createWebLlmProvider(os: Kernel, cfg: AgentConfig): Provider {
  return {
    id: 'webllm',
    contextBudget: 3000,
    contextWindow: 4096,
    async turn(req: TurnRequest): Promise<TurnResult> {
      if (!os.hasCap('webgpu')) throw new ProviderError('This browser has no WebGPU, which the in-browser model needs. Choose another provider in Settings → Model.');
      const engine = await getEngine(os, cfg.webllmModel, req.onStatus);
      req.onStatus('');
      const pid = current?.pid ?? 0;
      os.procs.update(pid, { state: 'running' });
      const started = performance.now();
      const abort = () => engine.interruptGenerate();
      req.signal.addEventListener('abort', abort);
      let full = '';
      let shown = 0;
      const usage = { input: 0, output: 0, cacheRead: 0 };
      try {
        const stream = await engine.chat.completions.create({ messages: toChat(req), stream: true, stream_options: { include_usage: true }, temperature: 0.2 });
        for await (const chunk of stream) {
          full += chunk.choices[0]?.delta?.content ?? '';
          if (chunk.usage) Object.assign(usage, { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens });
          // Stream prose, but hold back anything that may be the start of a tool call.
          const cut = full.indexOf('<tool_call');
          const safe = cut >= 0 ? cut : Math.max(shown, full.length - 10);
          if (safe > shown) {
            req.onText(full.slice(shown, safe));
            shown = safe;
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

      const content: Block[] = [];
      const call = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/.exec(full);
      const text = (call ? full.slice(0, call.index) : full).trim();
      if (!call && full.length > shown) req.onText(full.slice(shown));
      if (text) content.push({ type: 'text', text });
      if (call) {
        let name = 'unknown';
        let input: Record<string, unknown> = {};
        let invalid: string | undefined;
        try {
          const parsed = JSON.parse(call[1]!) as { name?: string; arguments?: Record<string, unknown> };
          name = String(parsed.name ?? 'unknown');
          input = parsed.arguments ?? {};
        } catch {
          invalid = call[1];
        }
        content.push({ type: 'tool_use', id: `local_${Date.now()}`, name, input, invalid });
      }
      return { content, stop: call ? 'tool_use' : 'end', usage, model: cfg.webllmModel };
    },
  };
}
