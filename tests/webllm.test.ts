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
/** The loaded model's context window, as WebLLM enforces it. */
let window = 4096;
/** Scripted replies: text, or text plus how generation ended and the engine's own speed figures. */
let replies: Array<string | { text: string; finish?: string; extra?: Record<string, number> }> = [];
/** Token count as a real tokenizer reports it: about 4 Latin characters per token, but about one per CJK character. */
const tokens = (msgs: ChatMsg[]) => {
  const text = msgs.map((m) => m.content).join('');
  const ascii = [...text].filter((c) => c.charCodeAt(0) < 128).length;
  return Math.ceil(ascii / 4 + (text.length - ascii));
};

vi.mock('@mlc-ai/web-llm', () => ({
  prebuiltAppConfig: {
    model_list: [
      { model_id: 'tiny', model: 'https://example/tiny', model_lib: 'https://example/tiny.wasm', vram_required_MB: 500, overrides: { context_window_size: 4096 } },
      { model_id: 'tiny-2k', model: 'https://example/tiny-2k', model_lib: 'https://example/tiny-2k.wasm', vram_required_MB: 500, overrides: { context_window_size: 2048 } },
      // Two models sharing one GPU library, as some catalogue models do.
      { model_id: 'pair-a', model: 'https://example/pair-a', model_lib: 'https://example/shared.wasm', vram_required_MB: 900 },
      { model_id: 'pair-b', model: 'https://example/pair-b', model_lib: 'https://example/shared.wasm', vram_required_MB: 900 },
    ],
  },
  CreateMLCEngine: async (id: string) => ((window = id === 'tiny-2k' ? 2048 : 4096), {
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
          // Like WebLLM, a prompt longer than the window is an error.
          if (tokens(req.messages) > window) throw new Error(`Prompt tokens exceed context window size: ${tokens(req.messages)} > ${window}`);
          const next = replies.shift() ?? 'OK.';
          const { text, finish = 'stop', extra } = typeof next === 'string' ? { text: next } : next;
          return (async function* () {
            // Streamed in small pieces, like a real engine.
            for (let i = 0; i < text.length; i += 7) yield { choices: [{ delta: { content: text.slice(i, i + 7) } }] };
            memory = [...req.messages, { role: 'assistant', content: text }];
            yield { choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(text.length / 4), extra } };
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
  window = 4096;
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

describe('in-browser model: limits', () => {
  it("uses each model's own window (2k models too)", async () => {
    const { agent, os } = await setup('tiny-2k');
    for (let i = 0; i < 10; i++) {
      replies.push(`Reply ${i}: ${'words '.repeat(80)}`);
      await agent.send(`Message ${i}: ${'text '.repeat(80)}`);
    }
    expect(userTexts(sent.at(-1)!)).toContain('Message 9');
    const report = await agent.context();
    expect(report.window).toBe(2048);
    expect(report.rolling).toBe(true);
    expect(report.autoCompactAt).toBe(0);
    void os;
  });

  it('keeps fitting when the text is Chinese, Japanese or emoji', async () => {
    const { agent, events } = await setup();
    // ~1 token per character: far more tokens than a characters ÷ 4 guess.
    const cjk = (n: number) => '我们今天讨论一下这个问题的解决方案。'.repeat(n);
    for (let i = 0; i < 8; i++) {
      replies.push(cjk(30));
      await agent.send(`${i}: ${cjk(30)}`);
    }
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(sent.length).toBe(8);
  });

  it('says when a reply was cut off at the output limit, and does not run a half-written call', async () => {
    const { agent, events } = await setup();
    replies = [{ text: '<tool_call>{"name": "write_file", "arguments": {"path": "a.txt", "content": "lots of text', finish: 'length' }];
    await agent.send('write a long file');
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    expect(events.some((e) => e.type === 'note' && /output limit|cut off/i.test(String(e.text)))).toBe(true);
  });

  it("uses the engine's own speed figures", async () => {
    const { agent, events } = await setup();
    replies = [{ text: 'Hello.', extra: { decode_tokens_per_s: 12.5, time_to_first_token_s: 1.5 } }];
    await agent.send('hi');
    const usage = events.find((e) => e.type === 'usage') as unknown as { stats: { tps: number; ttft: number } };
    expect(usage.stats.tps).toBe(12.5);
    expect(usage.stats.ttft).toBe(1500);
  });
});

describe('in-browser model store', () => {
  // A small Cache Storage, as browsers have (Node does not).
  const stores = new Map<string, Map<string, Response>>();
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    const key = (r: string | Request) => (typeof r === 'string' ? r : r.url);
    return {
      match: async (r: string | Request) => m.get(key(r))?.clone(),
      put: async (r: string | Request, res: Response) => void m.set(key(r), res.clone()),
      delete: async (r: string | Request) => m.delete(key(r)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  beforeEach(() => {
    stores.clear();
    vi.stubGlobal('caches', { open: async (name: string) => cacheFor(name) });
  });
  const settingsStore = () => {
    const data = new Map<string, unknown>();
    return { get: <T,>(k: string, f: T) => (data.has(k) ? (data.get(k) as T) : f), set: (k: string, v: unknown) => void data.set(k, v) };
  };
  const fakeDownload = async (model: string) => {
    const base = `${model}/resolve/main/`;
    await (await caches.open('webllm/model')).put(`${base}tensor-cache.json`, new Response(JSON.stringify({ records: [{ dataPath: 'p.bin', nbytes: 1 }] })));
    await (await caches.open('webllm/model')).put(`${base}p.bin`, new Response('x'));
    await (await caches.open('webllm/config')).put(`${base}mlc-chat-config.json`, new Response('{}'));
    await (await caches.open('webllm/wasm')).put('https://example/shared.wasm', new Response('w'));
  };

  it('deleting one model keeps a GPU library another downloaded model shares', async () => {
    const { remove, isDownloaded } = await import('../src/agent/providers/webllm-store');
    const settings = settingsStore();
    await fakeDownload('https://example/pair-a');
    await fakeDownload('https://example/pair-b');
    await remove(settings, 'pair-a');
    expect(await isDownloaded(settings, 'pair-a')).toBe(false);
    expect(await isDownloaded(settings, 'pair-b')).toBe(true);
    await remove(settings, 'pair-b');
    expect(await (await caches.open('webllm/wasm')).match('https://example/shared.wasm')).toBeUndefined();
  });

  it('an imported model never hides behind a catalogue model of the same name', async () => {
    const { importFolder, appConfig } = await import('../src/agent/providers/webllm-store');
    const settings = settingsStore();
    const file = (name: string, body: string) => new File([body], name);
    const id = await importFolder(settings, [file('mlc-chat-config.json', JSON.stringify({ model_id: 'tiny' })), file('ndarray-cache.json', '{"records":[]}'), file('lib.wasm', 'w')]);
    expect(id).toBe('tiny-local');
    const first = (await appConfig(settings)).model_list.find((m) => m.model_id === id);
    expect(first?.model).toContain('models.browserbox.local');
  });
});

describe('changes, undo and plan mode', () => {
  const call = (name: string, args: Record<string, unknown>) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

  it('shows what a file tool changed, and rewinds the chat and the files', async () => {
    const { agent, os, events } = await setup();
    await os.fs.writeFile('/home/agent/notes.txt', 'one\ntwo\nthree\n');
    replies = [call('write_file', { path: 'notes.txt', content: 'one\n2\nthree\nfour\n' }), 'Updated.', call('write_file', { path: 'new.txt', content: 'hello\n' }), 'Created.'];
    await agent.send('Change notes');
    await agent.send('Add a new file');
    const diffs = events.filter((e) => e.type === 'file_change').map((e) => e.diff as { path: string; added: number; removed: number; before: string | null });
    expect(diffs.map((d) => [d.path, d.added, d.removed, d.before])).toEqual([
      ['/home/agent/notes.txt', 2, 1, 'file'],
      ['/home/agent/new.txt', 1, 0, null],
    ]);
    expect(Object.keys(agent.diffs)).toHaveLength(2);

    // Rewind to the second message, undoing its file changes: new.txt goes away, notes.txt stays edited.
    const second = agent.transcript.findIndex((m) => m.role === 'user' && JSON.stringify(m.content).includes('Add a new file'));
    const r = await agent.rewind(second, true);
    expect(r.restored).toEqual(['/home/agent/new.txt']);
    expect(await os.fs.exists('/home/agent/new.txt')).toBe(false);
    expect(await os.fs.readText('/home/agent/notes.txt')).toBe('one\n2\nthree\nfour\n');
    expect(agent.transcript).toHaveLength(second);
    expect(Object.keys(agent.diffs)).toHaveLength(1);

    // Rewind to the first, keeping files: the chat goes back, the edit stays.
    await agent.rewind(0, false);
    expect(agent.transcript).toHaveLength(0);
    expect(await os.fs.readText('/home/agent/notes.txt')).toBe('one\n2\nthree\nfour\n');
    // The model's view went back too: the next message starts afresh.
    replies = ['Hi.'];
    await agent.send('Start over');
    expect(userTexts(sent.at(-1)!)).not.toContain('Change notes');
  });

  it('undoes deletes and moves, including folders', async () => {
    const { os } = await setup();
    const { Checkpoints } = await import('../src/agent/checkpoints');
    await os.fs.writeFile('/home/agent/dir/a.txt', 'a\n');
    await os.fs.writeFile('/home/agent/dir/b.bin', new Uint8Array([0, 1, 2, 255]));
    await os.fs.writeFile('/home/agent/keep.txt', 'precious\n');
    const cps = new Checkpoints(os);
    cps.begin(4);
    // As the agent does: capture what a tool will touch, then run it.
    await cps.capture(['/home/agent/dir']);
    await os.fs.rm('/home/agent/dir', { recursive: true });
    await cps.capture(['/home/agent/keep.txt', '/home/agent/moved.txt']);
    await os.fs.mv('/home/agent/keep.txt', '/home/agent/moved.txt');
    const r = await cps.restore(0);
    expect(r.skipped).toEqual([]);
    expect(await os.fs.readText('/home/agent/dir/a.txt')).toBe('a\n');
    expect([...(await os.fs.readFile('/home/agent/dir/b.bin'))]).toEqual([0, 1, 2, 255]);
    expect(await os.fs.readText('/home/agent/keep.txt')).toBe('precious\n');
    expect(await os.fs.exists('/home/agent/moved.txt')).toBe(false);
  });

  it('plan mode looks but does not change anything', async () => {
    const { agent, os, events } = await setup();
    replies = [call('write_file', { path: 'x.txt', content: 'no' }), '1. Create x.txt'];
    await agent.send('Make x.txt', { plan: true });
    expect(await os.fs.exists('/home/agent/x.txt')).toBe(false);
    const result = events.find((e) => e.type === 'tool_end') as { result: string; isError: boolean } | undefined;
    expect(result?.isError).toBe(true);
    // The model was told it is planning, and was not offered tools that change things.
    expect(sent[0]!.at(-1)!.content).toContain('Plan mode');
    expect(sent[0]![0]!.content).not.toContain('write_file(');
  });
});

describe('chat titles', () => {
  it('use only what the person typed', async () => {
    const { titleFrom } = await import('../src/agent/session');
    const msg = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Fix the bug in @app.js\n\n<file path="/home/agent/app.js">\nconst a = 1;\n</file>\n\n<mode>Plan mode: …</mode>' }] };
    expect(titleFrom([msg])).toBe('Fix the bug in @app.js');
  });
});
