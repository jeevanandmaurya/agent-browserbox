import type { AgentConfig } from '../config';
import { ProviderError, type Block, type Msg, type Provider, type TurnRequest, type TurnResult } from '../types';

interface WireMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface Chunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function toWire(system: string, messages: Msg[]): WireMsg[] {
  const out: WireMsg[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Yields the JSON payload of each `data:` line of a server-sent event stream. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

/**
 * Any server that speaks the OpenAI chat-completions protocol: Ollama,
 * LM Studio, llama.cpp, vLLM, or a hosted endpoint. This is how BrowserBox
 * connects to a local LLM — the request goes straight from the tab to the server.
 */
export function createOpenAiProvider(cfg: AgentConfig, apiKey: string | null): Provider {
  const base = cfg.openaiBaseUrl.replace(/\/+$/, '');
  return {
    id: 'openai',
    contextBudget: 24000,
    async turn(req: TurnRequest): Promise<TurnResult> {
      if (!cfg.openaiModel) throw new ProviderError('No model selected for the local server. Pick one in Settings → Model.');
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          signal: req.signal,
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: cfg.openaiModel,
            stream: true,
            messages: toWire(req.system, req.messages),
            ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
          }),
        });
      } catch (err) {
        if (req.signal.aborted) throw err;
        throw new ProviderError(`Could not reach ${base}. Is the server running, and does it allow this page's origin (CORS)? For Ollama: OLLAMA_ORIGINS="*" ollama serve`, true);
      }
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new ProviderError(`${base} answered ${res.status}: ${detail.slice(0, 400) || res.statusText}`, res.status >= 500);
      }

      let text = '';
      let thinking = '';
      let finish = '';
      let model = cfg.openaiModel;
      const usage = { input: 0, output: 0, cacheRead: 0 };
      const calls: Array<{ id: string; name: string; args: string }> = [];
      for await (const data of sse(res.body)) {
        if (data === '[DONE]') break;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.usage) Object.assign(usage, { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 });
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta;
        if (d?.content) {
          text += d.content;
          req.onText(d.content);
        }
        const r = d?.reasoning_content ?? d?.reasoning;
        if (r) {
          thinking += r;
          req.onThinking(r);
        }
        for (const tc of d?.tool_calls ?? []) {
          const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const content: Block[] = [];
      if (thinking) content.push({ type: 'thinking', text: thinking });
      if (text) content.push({ type: 'text', text });
      calls.filter(Boolean).forEach((c, i) => {
        let input: Record<string, unknown> = {};
        let invalid: string | undefined;
        try {
          const parsed: unknown = JSON.parse(c.args || '{}');
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          else invalid = c.args;
        } catch {
          invalid = c.args;
        }
        content.push({ type: 'tool_use', id: c.id || `call_${Date.now()}_${i}`, name: c.name, input, invalid });
      });
      const hasCalls = content.some((b) => b.type === 'tool_use');
      return { content, stop: hasCalls ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end', usage, model };
    },
  };
}
