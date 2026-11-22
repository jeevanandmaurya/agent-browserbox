import type Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type Block, type Msg, type Provider, type TurnRequest, type TurnResult } from '../types.js';

type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];
type Sdk = typeof import('@anthropic-ai/sdk').default;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicOptions {
  /** An Anthropic API key. In a browser it is sent only to api.anthropic.com. */
  apiKey: string;
  /** Default: 'claude-opus-5-5'. */
  model?: string;
  /** Thinking depth and token spend. Default: 'medium' (also the API's default on Claude Opus 5.5). */
  effort?: Effort;
  /** Let Claude search and fetch the web (server-side tools). Default: false. */
  webSearch?: boolean;
  /** Per-response output cap. Default: 64000. */
  maxTokens?: number;
}

/** Models that accept server-side refusal fallbacks. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);
/** Models known to take adaptive thinking + effort; other ids get a plain request. */
const ADAPTIVE = /^claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/;

function toParams(messages: Msg[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.BetaMessageParam => {
    // Our own earlier turns go back byte-for-byte: thinking and server-tool
    // blocks are signed, and the API rejects edited history.
    if (m.role === 'assistant' && m.raw?.provider === 'anthropic') return { role: 'assistant', content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] };
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      else if (b.type === 'tool_result') content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error });
    }
    return { role: m.role, content: content.length ? content : [{ type: 'text', text: '(empty)' }] };
  });
}

function toBlocks(content: Anthropic.Beta.BetaContentBlock[]): Block[] {
  const out: Block[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking' && b.thinking) out.push({ type: 'thinking', text: b.thinking });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    else if (b.type === 'server_tool_use' || b.type === 'mcp_tool_use') out.push({ type: 'server_note', text: `${b.name}: ${JSON.stringify(b.input)}` });
  }
  return out;
}

function explain(A: Sdk, err: unknown): never {
  if (err instanceof A.AuthenticationError) throw new ProviderError('Anthropic rejected the API key.');
  if (err instanceof A.PermissionDeniedError) throw new ProviderError(`Anthropic denied the request: ${err.message}`);
  if (err instanceof A.NotFoundError) throw new ProviderError(`Model not found: ${err.message}`);
  if (err instanceof A.RateLimitError) throw new ProviderError('Rate limited by Anthropic. Wait a moment and try again.', true);
  if (err instanceof A.BadRequestError) throw new ProviderError(`Anthropic rejected the request: ${err.message}`);
  if (err instanceof A.APIUserAbortError) throw err;
  if (err instanceof A.APIConnectionError) throw new ProviderError('Could not reach api.anthropic.com. Check your connection.', true);
  if (err instanceof A.APIError) throw new ProviderError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, (err.status ?? 0) >= 500);
  throw err;
}

/**
 * Claude, through the official Anthropic SDK (loaded the first time it is
 * used, so apps that use another model never download it).
 */
export function anthropic(opts: AnthropicOptions): Provider {
  if (!opts.apiKey) throw new ProviderError('anthropic(): an apiKey is required.');
  const model = opts.model ?? 'claude-opus-5-5';
  const betas: string[] = [];
  const fallback = FALLBACK_MODELS.has(model);
  // On a safety decline, the API re-runs the request on a fallback model it picks by category.
  if (fallback) betas.push('server-side-fallback-2026-07-01');
  let sdk: Promise<{ A: Sdk; client: Anthropic }> | null = null;
  const load = () =>
    (sdk ??= import('@anthropic-ai/sdk').then(({ default: A }) => ({ A, client: new A({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true }) })));

  return {
    id: 'anthropic',
    contextWindow: model.startsWith('claude-haiku-4') ? 200_000 : 1_000_000,
    async turn(req: TurnRequest): Promise<TurnResult> {
      const { A, client } = await load();
      const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
        // Stream large inputs (file bodies, code) as they are generated. The
        // agent validates every input against its schema before running it.
        eager_input_streaming: true,
      }));
      if (opts.webSearch) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }, { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 });
      const params = {
        model,
        max_tokens: opts.maxTokens ?? 64000,
        system: req.system,
        messages: toParams(req.messages),
        tools,
        cache_control: { type: 'ephemeral' },
        ...(ADAPTIVE.test(model) ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: opts.effort ?? 'medium' } } : {}),
        ...(betas.length ? { betas } : {}),
        ...(fallback ? { fallbacks: 'default' } : {}),
      } as StreamParams;

      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.beta.messages.stream(params, { signal: req.signal });
          for await (const event of stream) {
            if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') req.onText(event.delta.text);
              else if (event.delta.type === 'thinking_delta') req.onThinking(event.delta.thinking);
            } else if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') {
              req.onStatus(`Using ${event.content_block.name}…`);
            }
          }
          const message = await stream.finalMessage();
          const stop: TurnResult['stop'] =
            message.stop_reason === 'tool_use' ? 'tool_use' : message.stop_reason === 'max_tokens' ? 'max_tokens' : message.stop_reason === 'refusal' ? 'refusal' : message.stop_reason === 'pause_turn' ? 'pause' : 'end';
          return {
            content: toBlocks(message.content),
            raw: { provider: 'anthropic', content: message.content },
            stop,
            usage: { input: message.usage.input_tokens, output: message.usage.output_tokens, cacheRead: message.usage.cache_read_input_tokens ?? 0 },
            model: message.model,
          };
        } catch (err) {
          if (req.signal.aborted) throw err;
          // A non-API error here is a tool input the SDK could not parse at all
          // (possible with eager streaming): re-issue the turn, at most twice.
          if (!(err instanceof A.APIError) && attempt < 2) continue;
          explain(A, err);
        }
      }
    },
  };
}
