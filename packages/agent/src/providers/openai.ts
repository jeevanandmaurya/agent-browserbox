import { relayed, unreachable, type AgentConfig } from '../config.js';
import { ProviderError, type Block, type Msg, type Provider, type TurnRequest, type TurnResult } from '../types.js';

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface WireMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Part[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface Chunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export function toWire(system: string, messages: Msg[]): WireMsg[] {
  const out: WireMsg[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      // Tool messages carry text only, so images a tool showed follow as a user message.
      const shown = m.content.flatMap((b) => (b.type === 'tool_result' ? (b.images ?? []) : []));
      const images = [...m.content.flatMap((b) => (b.type === 'image' ? [b] : [])), ...shown].flatMap((i) => (i.data ? [{ type: 'image_url' as const, image_url: { url: `data:${i.mediaType};base64,${i.data}` } }] : []));
      if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: text || 'The images from the tool results above.' }, ...images] });
      else if (text) out.push({ role: 'user', content: text });
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
/** Where to send requests: a local model server or a hosted OpenAI-compatible API. */
export interface ServerTarget {
  kind: 'local' | 'api';
  baseUrl: string;
  model: string;
}

export function createOpenAiProvider(cfg: AgentConfig, target: ServerTarget, apiKey: string | null): Provider {
  const base = target.baseUrl.replace(/\/+$/, '');
  const where = target.kind === 'local' ? 'the local server' : 'the API';
  // Hosted APIs without CORS (ollama.com) go through the relay the user set; local servers never do.
  const relay = target.kind === 'api' ? cfg.corsRelay : '';
  let usageOption = true;
  return {
    id: target.kind === 'api' ? 'openai' : 'local',
    contextBudget: Math.floor(cfg.contextWindow * 0.75),
    contextWindow: cfg.contextWindow,
    async turn(req: TurnRequest): Promise<TurnResult> {
      if (!target.model) throw new ProviderError(`No model selected for ${where}. Pick one in Settings → Model.`);
      const request = (withUsage: boolean) =>
        fetch(relayed(`${base}/chat/completions`, relay), {
          method: 'POST',
          signal: req.signal,
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: target.model,
            stream: true,
            // Without this, OpenAI and most compatible servers send no token counts in a stream.
            ...(withUsage && usageOption ? { stream_options: { include_usage: true } } : {}),
            messages: toWire(req.system, req.messages),
            ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
          }),
        });
      let res: Response;
      try {
        res = await request(true);
        // A server that rejects the option: ask again without it, and stop sending it.
        if (res.status === 400 && usageOption) {
          const detail = await res.clone().text().catch(() => '');
          if (/stream_options|include_usage/i.test(detail)) {
            usageOption = false;
            res = await request(false);
          }
        }
      } catch (err) {
        if (req.signal.aborted) throw err;
        throw new ProviderError(unreachable(base, target.kind, relay), true);
      }
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new ProviderError(`${base} answered ${res.status}: ${detail.slice(0, 400) || res.statusText}`, res.status >= 500);
      }

      let text = '';
      let thinking = '';
      let finish = '';
      let model = target.model;
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
          // Some servers leave out the index: match by id, or start a new call when an id first appears.
          const at = typeof tc.index === 'number' ? tc.index : tc.id ? (calls.findIndex((c) => c?.id === tc.id) + 1 || calls.length + 1) - 1 : Math.max(0, calls.length - 1);
          const slot = (calls[at] ??= { id: '', name: '', args: '' });
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
      // Cut off by the output limit: a tool call in it may be half-written, so it must not run.
      return { content, stop: finish === 'length' ? 'max_tokens' : hasCalls ? 'tool_use' : 'end', usage, model };
    },
  };
}
