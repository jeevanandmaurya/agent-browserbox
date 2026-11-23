import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../packages/agent/src/config';
import { createOpenAiProvider } from '../packages/agent/src/providers/openai';
import type { TurnRequest } from '../packages/agent/src/types';

const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const req = (): TurnRequest => ({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], signal: new AbortController().signal, onText: () => undefined, onThinking: () => undefined, onStatus: () => undefined });
const provider = () => createOpenAiProvider(DEFAULT_CONFIG, { kind: 'api', baseUrl: 'https://api.test/v1', model: 'm' }, 'k');

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible streams', () => {
  it('asks for token counts and reads them', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), sse([{ choices: [{ delta: { content: 'hey' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 3 } }])));
    const r = await provider().turn(req());
    expect(JSON.parse(bodies[0]!).stream_options).toEqual({ include_usage: true });
    expect(r.usage).toMatchObject({ input: 120, output: 3 });
  });

  it('retries without the option when a server rejects it', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return bodies.length === 1 ? new Response('unknown field stream_options', { status: 400 }) : sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    });
    const r = await provider().turn(req());
    expect(r.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(JSON.parse(bodies[1]!).stream_options).toBeUndefined();
  });

  it('keeps tool calls that come without an index, and never runs a call cut off by the limit', async () => {
    vi.stubGlobal('fetch', async () =>
      sse([
        { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '"x"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'list_dir', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      ]),
    );
    const r = await provider().turn(req());
    expect(r.content.filter((b) => b.type === 'tool_use').map((b) => b.type === 'tool_use' && [b.id, b.name, b.input])).toEqual([['a', 'read_file', { path: 'x' }], ['b', 'list_dir', {}]]);
    vi.stubGlobal('fetch', async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write_file', arguments: '{"path":"a","content":"hal' } }] }, finish_reason: 'length' }] }]));
    expect((await provider().turn(req())).stop).toBe('max_tokens');
  });
});
