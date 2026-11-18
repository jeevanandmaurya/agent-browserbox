import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The in-browser model, driven through the real agent loop with a scripted
 * stand-in for WebLLM's engine: what the model is sent each turn, and how its
 * replies are parsed into text and tool calls.
 */

type ChatMsg = { role: string; content: string };
const sent: ChatMsg[][] = [];
const options: Array<Record<string, unknown>> = [];
/** The conversation the fake engine holds after its last reply (WebLLM's KV cache). */
let memory: ChatMsg[] | null = null;
let replies: string[] = [];
/** Rough token count, as a real tokenizer would report (about 4 characters per token). */
const tokens = (msgs: ChatMsg[]) => Math.ceil(msgs.reduce((n, m) => n + m.content.length, 0) / 4);

vi.mock('@mlc-ai/web-llm', () => ({
  prebuiltAppConfig: { model_list: [{ model_id: 'tiny', model: 'https://example/tiny', model_lib: 'https://example/tiny.wasm', vram_required_MB: 500, overrides: { context_window_size: 4096 } }] },
  CreateMLCEngine: async () => ({
    unload: async () => undefined,
    interruptGenerate: () => undefined,
    chat: {
      completions: {
        create: async (req: { messages: ChatMsg[] } & Record<string, unknown>) => {
          // Like WebLLM: when the history matches what is already in GPU memory, only the
          // new message is processed, and prompt_tokens counts only that.
          const prior = req.messages.slice(0, -1);
          const reused = memory !== null && JSON.stringify(prior) === JSON.stringify(memory);
          const promptTokens = reused ? tokens(req.messages.slice(-1)) : tokens(req.messages);
          sent.push(structuredClone(req.messages));
          options.push({ ...req, messages: undefined });
          const text = replies.shift() ?? 'OK.';
          return (async function* () {
            // Streamed in small pieces, like a real engine.
            for (let i = 0; i < text.length; i += 7) yield { choices: [{ delta: { content: text.slice(i, i + 7) } }] };
            memory = [...req.messages, { role: 'assistant', content: text }];
            yield { choices: [{ delta: {} }], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(text.length / 4) } };
          })();
        },
      },
    },
  }),
}));

const { KernelCore } = await import('../src/kernel/kernel');
const { MemFs } = await import('../src/kernel/vfs/memfs');
const { Agent } = await import('../src/agent/agent');

async function setup(model = 'tiny') {
  const os = new KernelCore();
  os.fs.mount('/', new MemFs());
  os.fs.markReady();
  await os.fs.mkdir('/home/agent');
  const gpu = os.caps.find((c) => c.id === 'webgpu');
  if (gpu) gpu.ok = true;
  else os.caps.push({ id: 'webgpu', label: 'WebGPU', ok: true } as never);
  os.settings.set('agent.config', { provider: 'webllm', webllmModel: model });
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const agent = new Agent(os, { onEvent: (e) => events.push(e as never), ask: async () => 'yes', prompter: async () => 'always' as never });
  return { os, agent, events };
}

const userTexts = (msgs: ChatMsg[]) => msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

beforeEach(() => {
  memory = null;
  sent.length = 0;
  options.length = 0;
  replies = [];
});

describe('in-browser model: memory across messages', () => {
  it('sends earlier messages with every new one', async () => {
    const { agent } = await setup();
    replies = ['Hello Ada!', 'Your name is Ada and you like green.'];
    await agent.send('My name is Ada and my favourite colour is green.');
    await agent.send('What is my name?');
    expect(sent).toHaveLength(2);
    expect(userTexts(sent[1]!)).toContain('My name is Ada');
    expect(sent[1]!.some((m) => m.role === 'assistant' && m.content.includes('Hello Ada'))).toBe(true);
  });

  it('reports the whole conversation as context, even when the engine reuses its memory', async () => {
    const { agent, events } = await setup();
    replies = ['I can help with that. What would you like to do?', 'Sure, here is how to run Python.', 'You asked for help, then about Python.'];
    await agent.send('Help');
    await agent.send('Run python');
    await agent.send('What did I ask first?');
    // The engine processed only the new message each time…
    expect(sent.at(-1)!.some((m) => m.content === 'Help')).toBe(true);
    // …but the context shown grows with the conversation instead of resetting.
    const used = events.filter((e) => e.type === 'usage').map((e) => (e.context as { used: number }).used);
    expect(used).toHaveLength(3);
    expect(used[1]!).toBeGreaterThan(used[0]!);
    expect(used[2]!).toBeGreaterThan(used[1]!);
  });

  it('remembers the start of a longer chat instead of summarising it away', async () => {
    const { agent, events } = await setup();
    await agent.send('My name is Ada and my favourite colour is green.');
    for (let i = 0; i < 12; i++) {
      replies.push(`Here is a longer answer number ${i}. ${'Some detail. '.repeat(40)}`);
      await agent.send(`Question ${i}: tell me something about topic ${i}. ${'context '.repeat(30)}`);
    }
    const last = sent.at(-1)!;
    // The model always gets the newest message, and never more than its window.
    expect(userTexts(last)).toContain('Question 11');
    expect(tokens(last)).toBeLessThan(4096 - 512);
    // A tiny model is not asked to summarise the conversation (it does so badly and the chat is lost).
    expect(events.some((e) => e.type === 'compact')).toBe(false);
    expect(sent.some((msgs) => userTexts(msgs).includes('context window is nearly full'))).toBe(false);
  });
});

describe('in-browser model: reasoning does not crowd out the conversation', () => {
  it('still knows the first message after several long-thinking replies', async () => {
    const { agent } = await setup();
    replies = ['<think>' + 'Let me consider this carefully. '.repeat(120) + '</think>Nice to meet you, Ada.'];
    await agent.send('My name is Ada.');
    for (let i = 0; i < 4; i++) {
      replies.push('<think>' + 'Hmm, thinking it over again. '.repeat(120) + `</think>Answer ${i}.`);
      await agent.send(`Small question ${i}?`);
    }
    replies.push('Your name is Ada.');
    await agent.send('What is my name?');
    const last = sent.at(-1)!;
    expect(userTexts(last)).toContain('My name is Ada');
    expect(last.some((m) => m.content.includes('<think>') || m.content.includes('thinking it over'))).toBe(false);
  });

  it('turns thinking off for Qwen3 only', async () => {
    const q = await setup('Qwen3-1.7B-q4f16_1-MLC');
    await q.agent.send('hi');
    expect(options.at(-1)?.extra_body).toEqual({ enable_thinking: false });
    const other = await setup('tiny');
    await other.agent.send('hi');
    expect(options.at(-1)?.extra_body).toBeUndefined();
  });

  it('fits a conversation longer than the window, newest message first', async () => {
    const { agent } = await setup();
    for (let i = 0; i < 20; i++) {
      replies.push(`Reply ${i}: ${'words '.repeat(150)}`);
      await agent.send(`Message ${i}: ${'text '.repeat(150)}`);
    }
    const last = sent.at(-1)!;
    expect(userTexts(last)).toContain('Message 19');
    expect(Math.ceil(last.reduce((n, m) => n + m.content.length, 0) / 3.2)).toBeLessThanOrEqual(4096 - 768);
  });
});

describe('in-browser model: parsing replies', () => {
  const cases: Array<[string, string, { text?: RegExp; tool?: string }]> = [
    ['tags', 'Let me look.\n<tool_call>{"name": "list_dir", "arguments": {"path": "."}}</tool_call>', { text: /Let me look/, tool: 'list_dir' }],
    ['unclosed tag', '<tool_call>\n{"name": "list_dir", "arguments": {"path": "."}}', { tool: 'list_dir' }],
    ['json fence', 'I will list the files.\n```json\n{"name": "list_dir", "arguments": {"path": "."}}\n```', { text: /list the files/, tool: 'list_dir' }],
    ['bare json', '{"name": "list_dir", "arguments": {"path": "."}}', { tool: 'list_dir' }],
    ['parameters key', '<tool_call>{"name": "list_dir", "parameters": {"path": "."}}</tool_call>', { tool: 'list_dir' }],
    ['plain answer', 'The capital of France is Paris.', { text: /Paris/ }],
    ['code that is not a call', 'Here is JSON:\n```json\n{"a": 1}\n```', { text: /Here is JSON/ }],
  ];
  for (const [name, reply, want] of cases) {
    it(name, async () => {
      const { agent, events } = await setup();
      replies = [reply, 'Done.'];
      await agent.send('go');
      const msgs = agent.transcript.filter((m) => m.role === 'assistant');
      const first = msgs[0]!;
      const call = first.content.find((b) => b.type === 'tool_use') as { name: string; invalid?: string } | undefined;
      const text = first.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      if (want.tool) {
        expect(call?.name).toBe(want.tool);
        expect(call?.invalid).toBeUndefined();
      } else expect(call).toBeUndefined();
      if (want.text) expect(text).toMatch(want.text);
      // Nothing of the call protocol leaks into what the person reads.
      const shown = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
      expect(shown).not.toMatch(/<tool_call|"arguments"|"parameters"/);
    });
  }

  it('shows <think> reasoning as thinking, not as the answer', async () => {
    const { agent, events } = await setup();
    replies = ['<think>The user wants a greeting.</think>Hello there!'];
    await agent.send('hi');
    const shown = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('');
    expect(shown.trim()).toBe('Hello there!');
    expect(thinking).toContain('greeting');
    // Earlier reasoning is not sent back to the model.
    replies = ['Fine.'];
    await agent.send('again');
    expect(sent.at(-1)!.some((m) => m.content.includes('<think>'))).toBe(false);
  });
});
