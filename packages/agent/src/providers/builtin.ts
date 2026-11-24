import type { KernelCore as Kernel } from '../host/os.js';
import type { AgentConfig } from '../config.js';
import { ProviderError, type Block, type Provider, type TurnRequest, type TurnResult } from '../types.js';
import { estimateTokens, parseReply, toChat } from './webllm.js';
import { hasBuiltinModel, runBuiltinPrompt, type BuiltinPromptInput } from './builtin-run.js';

/** Chrome's on-device model takes about this much (its input quota); the reply needs room too. */
const WINDOW = 6144;
const RESERVE = 1024;

/**
 * The browser's built-in model (Chrome's Prompt API): no download by you, no
 * key, works offline once the browser has it. Small, like the WebGPU models,
 * so tools use the same plain-text call format.
 */
export async function createBuiltinProvider(os: Kernel, _cfg: AgentConfig): Promise<Provider> {
  const viaHost = os.builtinPrompt;
  if (!viaHost && !hasBuiltinModel()) throw new ProviderError('This browser has no built-in model. It is in Chrome on desktop (version 138 or later) on supported devices. Choose another source in Settings → Model.');
  return {
    id: 'builtin',
    contextBudget: 0,
    contextWindow: WINDOW,
    async turn(req: TurnRequest): Promise<TurnResult> {
      const chat = toChat(req, WINDOW, RESERVE);
      const last = chat.at(-1)!;
      const input: BuiltinPromptInput = {
        initialPrompts: chat.slice(0, -1) as BuiltinPromptInput['initialPrompts'],
        prompt: last.role === 'user' ? last.content : 'Continue.',
      };
      if (last.role !== 'user') input.initialPrompts.push(last as BuiltinPromptInput['initialPrompts'][number]);
      const started = performance.now();
      let full = '';
      try {
        // In a window, stream it here; from a worker, a window runs it and sends the whole reply.
        full = viaHost ? await viaHost(input, req.signal) : await runBuiltinPrompt(input, { signal: req.signal, onStatus: req.onStatus });
      } catch (err) {
        if (req.signal.aborted) throw req.signal.reason ?? err;
        throw new ProviderError(`The browser’s built-in model failed: ${(err as Error).message}`);
      }
      req.signal.throwIfAborted();
      const reply = parseReply(full, req.tools.map((t) => t.name));
      if (reply.text) req.onText(reply.text);
      const content: Block[] = [];
      if (reply.thinking.trim()) content.push({ type: 'thinking', text: reply.thinking.trim() });
      if (reply.text) content.push({ type: 'text', text: reply.text });
      if (reply.call) content.push({ type: 'tool_use', id: `builtin_${Date.now()}`, name: reply.call.name, input: reply.call.input, invalid: reply.call.invalid });
      const input_tokens = chat.reduce((n, m) => n + estimateTokens(m.content), 0);
      const output = estimateTokens(full);
      const secs = (performance.now() - started) / 1000;
      return { content, stop: reply.call ? 'tool_use' : 'end', usage: { input: input_tokens, output, cacheRead: 0 }, model: 'built-in (Prompt API)', speed: secs > 0 ? { tps: output / secs, ttft: 0 } : undefined };
    },
  };
}
