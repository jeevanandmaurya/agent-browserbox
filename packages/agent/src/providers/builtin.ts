import type { KernelCore as Kernel } from '../host/os.js';
import type { AgentConfig } from '../config.js';
import { ProviderError, type Block, type Provider, type TurnRequest, type TurnResult } from '../types.js';
import { estimateTokens, holdFrom, parseReply, splitThinking, toChat } from './webllm.js';
import { BuiltinTooLarge, hasBuiltinModel, runBuiltinPrompt, type BuiltinPromptInput, type BuiltinReply } from './builtin-run.js';

/** Until the browser says how large its model's window is (Chrome reports it per session). */
const DEFAULT_WINDOW = 4096;
/** The window the browser last reported; shared by every chat. */
let known: number | undefined;

/**
 * The browser's built-in model (Chrome's Prompt API): no download by you, no
 * key, works offline once the browser has it. Small, like the WebGPU models,
 * so tools use the same plain-text call format, and the conversation is fitted
 * to the window the browser reports (with less history when it still does not fit).
 */
export async function createBuiltinProvider(os: Kernel, _cfg: AgentConfig): Promise<Provider> {
  const viaHost = os.builtinPrompt;
  if (!viaHost && !hasBuiltinModel()) throw new ProviderError('This browser has no built-in model. It is in Chrome on desktop (version 138 or later) on supported devices. Choose another source in Settings → Model.');
  const run = async (input: BuiltinPromptInput, req: TurnRequest, onChunk: (t: string) => void): Promise<BuiltinReply> => {
    if (!viaHost) return runBuiltinPrompt(input, { signal: req.signal, onStatus: req.onStatus, onChunk });
    const r = await viaHost(input, req.signal, onChunk);
    if (r.tooLarge) throw new BuiltinTooLarge(r.window);
    return r;
  };
  return {
    id: 'builtin',
    contextBudget: 0,
    get contextWindow() {
      return known ?? DEFAULT_WINDOW;
    },
    async turn(req: TurnRequest): Promise<TurnResult> {
      const started = performance.now();
      let reply: BuiltinReply | null = null;
      // Streamed as it is written, holding back anything that may become a tool call.
      let full = '';
      let shown = 0;
      let shownThink = 0;
      const onChunk = (t: string) => {
        full += t;
        const { thinking, answer } = splitThinking(full);
        if (thinking.length > shownThink) {
          req.onThinking(thinking.slice(shownThink));
          shownThink = thinking.length;
        }
        const safe = holdFrom(answer);
        if (safe > shown) {
          req.onText(answer.slice(shown, safe));
          shown = safe;
        }
      };
      let chat: ReturnType<typeof toChat> = [];
      // Fit the conversation to the window; if it still does not fit, keep less of it.
      for (const fill of [1, 0.6, 0.35]) {
        const window = known ?? DEFAULT_WINDOW;
        chat = toChat(req, window, Math.min(1024, Math.floor(window / 4)), fill);
        const last = chat.at(-1)!;
        const input: BuiltinPromptInput = {
          initialPrompts: chat.slice(0, -1) as BuiltinPromptInput['initialPrompts'],
          prompt: last.role === 'user' ? last.content : 'Continue.',
        };
        if (last.role !== 'user') input.initialPrompts.push(last as BuiltinPromptInput['initialPrompts'][number]);
        try {
          reply = await run(input, req, onChunk);
          if (reply.window) known = reply.window;
          break;
        } catch (err) {
          if (req.signal.aborted) throw req.signal.reason ?? err;
          if (err instanceof BuiltinTooLarge) {
            if (err.window) known = err.window;
            if (fill !== 0.35) continue;
            throw new ProviderError(`${err.message} Start a new chat, or choose a larger model in Settings → Model.`);
          }
          throw new ProviderError(`The browser’s built-in model failed: ${(err as Error).message}`);
        }
      }
      req.signal.throwIfAborted();
      // A reply that was not streamed (an older browser) arrives whole.
      if (!full) onChunk(reply!.text);
      full = reply!.text || full;
      const parsed = parseReply(full, req.tools.map((t) => t.name));
      // Show what was held back: up to the tool call, or the rest of the answer.
      const { answer } = splitThinking(full);
      const end = parsed.call ? parsed.at : answer.length;
      if (end > shown) req.onText(answer.slice(shown, end));
      const content: Block[] = [];
      if (parsed.thinking.trim()) content.push({ type: 'thinking', text: parsed.thinking.trim() });
      if (parsed.text) content.push({ type: 'text', text: parsed.text });
      if (parsed.call) content.push({ type: 'tool_use', id: `builtin_${Date.now()}`, name: parsed.call.name, input: parsed.call.input, invalid: parsed.call.invalid });
      const input_tokens = chat.reduce((n, m) => n + estimateTokens(m.content), 0);
      const output = estimateTokens(full);
      const secs = (performance.now() - started) / 1000;
      return { content, stop: parsed.call ? 'tool_use' : 'end', usage: { input: input_tokens, output, cacheRead: 0 }, model: 'built-in (Prompt API)', speed: secs > 0 ? { tps: output / secs, ttft: 0 } : undefined };
    },
  };
}
