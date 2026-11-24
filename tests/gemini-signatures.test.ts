import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiProvider, toWire } from '../packages/agent/src/providers/openai';
import { DEFAULT_CONFIG } from '../packages/agent/src/config';
import type { Msg, TurnRequest } from '../packages/agent/src/types';

const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const sig = { google: { thought_signature: 'c2lnbmVkLWJ5LWdlbWluaQ==' } };

function request(messages: Msg[]): TurnRequest {
  return { system: 'sys', messages, tools: [{ name: 'list_dir', description: 'list', input_schema: { type: 'object', properties: {} } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {}, onStatus: () => {} } as unknown as TurnRequest;
}

describe('Gemini thought signatures (OpenAI-compatible API)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the signature on a tool call and sends it back to Google, not to other servers', async () => {
    const bodies: Array<{ url: string; body: { messages: Array<{ tool_calls?: Array<{ extra_content?: unknown }> }> } }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init.body)) });
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_dir', arguments: '{}' }, extra_content: sig }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
    });
    const cfg = { ...DEFAULT_CONFIG, contextWindow: 32000 };
    const gemini = createOpenAiProvider(cfg, { kind: 'api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-x' }, 'key');
    const first = await gemini.turn(request([{ role: 'user', content: [{ type: 'text', text: 'list files' }] }]));
    const call = first.content.find((b) => b.type === 'tool_use');
    expect(call && call.type === 'tool_use' && call.extra).toEqual({ extra_content: sig });

    const history: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt' }] },
    ];
    await gemini.turn(request(history));
    const sent = bodies.at(-1)!.body.messages.find((m) => m.tool_calls)!;
    expect(sent.tool_calls![0]!.extra_content).toEqual(sig);

    // Another OpenAI-compatible server gets the plain call.
    expect(toWire('sys', history)[2]!.tool_calls![0]).not.toHaveProperty('extra_content');
    const openai = createOpenAiProvider(cfg, { kind: 'api', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' }, 'key');
    await openai.turn(request(history));
    expect(bodies.at(-1)!.body.messages.find((m) => m.tool_calls)!.tool_calls![0]).not.toHaveProperty('extra_content');
  });
});
