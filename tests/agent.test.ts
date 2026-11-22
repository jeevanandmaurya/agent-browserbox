import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { Agent, type AgentEvent, type Block, type Provider, type TurnRequest, type TurnResult } from '../packages/agent/src/index';
import { globToRegExp, normalize } from '../packages/agent/src/tools';

/** An in-memory box with just enough of the SDK's surface for the tools. */
function fakeBox(files: Record<string, string> = {}): BrowserBox & { files: Map<string, string>; commands: string[] } {
  const store = new Map(Object.entries(files));
  const commands: string[] = [];
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
  return {
    files: store,
    commands,
    home: '/home/user',
    storage: 'memory',
    fs: {
      readTextFile: async (p: string) => {
        if (!store.has(p)) throw enoent(p);
        return store.get(p)!;
      },
      writeFile: async (p: string, d: string) => void store.set(p, d),
      rm: async (p: string) => void store.delete(p),
      readdir: async (p: string) =>
        [...new Set([...store.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1).split('/')[0]!))].map((name) => {
          const full = `${p}/${name}`;
          return store.has(full) ? { path: full, name, kind: 'file' as const, size: store.get(full)!.length, mtime: 0 } : { path: full, name, kind: 'dir' as const, size: 0, mtime: 0 };
        }),
    },
    exec: async (command: string) => {
      commands.push(command);
      const find = /^find '([^']*)' -type f$/.exec(command);
      if (find) return { exitCode: 0, stdout: [...store.keys()].filter((k) => k.startsWith(`${find[1]}/`)).join('\n') + '\n', stderr: '' };
      if (command.startsWith('fail')) return { exitCode: 3, stdout: 'partial', stderr: 'boom' };
      return { exitCode: 0, stdout: `ran: ${command}\n`, stderr: '' };
    },
  } as unknown as BrowserBox & { files: Map<string, string>; commands: string[] };
}

type Step = (req: TurnRequest) => Partial<TurnResult> & { content: Block[] };
/** A model that plays back a script, one step per call, and records what it was sent. */
function scripted(steps: Step[]): Provider & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    id: 'scripted',
    contextWindow: 100_000,
    requests,
    async turn(req) {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      const step = steps[requests.length - 1];
      if (!step) throw new Error('script ran out');
      const r = step(req);
      const stop = r.stop ?? (r.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end');
      return { usage: { input: 10, output: 5, cacheRead: 0 }, model: 'scripted-1', ...r, stop };
    },
  };
}
const use = (id: string, name: string, input: Record<string, unknown>, extra: object = {}): Block => ({ type: 'tool_use', id, name, input, ...extra });
const say = (text: string): Block => ({ type: 'text', text });

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('agent loop', () => {
  it('runs tools in the box until the model answers, keeping the conversation valid', async () => {
    const box = fakeBox();
    const model = scripted([
      (req) => {
        req.onText('Writing it. ');
        return { content: [say('Writing it. '), use('a', 'write_file', { path: 'hello.txt', content: 'hi\nthere' }), use('b', 'shell', { command: 'ls' })] };
      },
      () => ({ content: [use('c', 'read_file', { path: '/home/user/hello.txt' })] }),
      () => ({ content: [say('Done: wrote hello.txt.')] }),
    ]);
    const agent = new Agent({ box, model });
    const events = await collect(agent.send('make hello.txt'));

    expect(box.files.get('/home/user/hello.txt')).toBe('hi\nthere');
    expect(box.commands).toContain('ls');
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'end', text: 'Done: wrote hello.txt.' });
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { call: { summary: string } }).call.summary)).toEqual(['Write hello.txt', 'Run: ls', 'Read /home/user/hello.txt']);
    expect(events[0]).toEqual({ type: 'text', delta: 'Writing it. ' });

    // Both results of the first turn come back in one user message, in order.
    const second = model.requests[1]!.messages;
    const results = second.at(-1)!.content;
    expect(results.map((b) => b.type === 'tool_result' && b.tool_use_id)).toEqual(['a', 'b']);
    // read_file numbers lines.
    const read = model.requests[2]!.messages.at(-1)!.content[0] as Extract<Block, { type: 'tool_result' }>;
    expect(read.content).toBe('1\thi\n2\tthere');
    expect(agent.usage).toEqual({ input: 30, output: 15, cacheRead: 0 });
    expect(agent.busy).toBe(false);
  });

  it('returns errors to the model instead of running bad calls', async () => {
    const box = fakeBox({ '/home/user/a.txt': 'x x' });
    const model = scripted([
      () => ({
        content: [
          use('1', 'write_file', { path: 'a.txt' }), // missing content
          use('2', 'no_such_tool', {}),
          use('3', 'shell', {}, { invalid: '{"command": "ls' }),
          use('4', 'edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }), // not unique
          use('5', 'read_file', { path: 'missing.txt' }),
          use('6', 'shell', { command: 'fail now' }),
        ],
      }),
      () => ({ content: [say('ok')] }),
    ]);
    await collect(new Agent({ box, model }).send('go'));
    const results = model.requests[1]!.messages.at(-1)!.content as Array<Extract<Block, { type: 'tool_result' }>>;
    expect(results.map((r) => [r.tool_use_id, !!r.is_error])).toEqual([['1', true], ['2', true], ['3', true], ['4', true], ['5', true], ['6', false]]);
    expect(results[0]!.content).toMatch(/missing required property "content"/);
    expect(results[1]!.content).toMatch(/Unknown tool/);
    expect(results[2]!.content).toMatch(/not valid JSON/);
    expect(results[3]!.content).toMatch(/occurs 2 times/);
    expect(results[4]!.content).toMatch(/ENOENT/);
    expect(results[5]!.content).toBe('partial\n[stderr]\nboom\n[exit code 3]');
    expect(box.files.get('/home/user/a.txt')).toBe('x x'); // nothing changed
  });

  it('asks approve() before every call, and tells the model when one is declined', async () => {
    const box = fakeBox();
    const seen: string[] = [];
    const model = scripted([() => ({ content: [use('1', 'shell', { command: 'rm -r /' }), use('2', 'write_file', { path: 'ok.txt', content: '1' })] }), () => ({ content: [say('fine')] })]);
    await collect(new Agent({ box, model, approve: (c) => (seen.push(c.summary), c.name !== 'shell') }).send('go'));
    expect(seen).toEqual(['Run: rm -r /', 'Write ok.txt']);
    expect(box.commands).toEqual([]);
    expect(box.files.has('/home/user/ok.txt')).toBe(true);
    const declined = model.requests[1]!.messages.at(-1)!.content[0] as Extract<Block, { type: 'tool_result' }>;
    expect(declined.is_error && declined.content).toMatch(/declined/);
  });

  it('stops mid-run, still answering every call the model made', async () => {
    const box = fakeBox();
    let agent!: Agent;
    const model = scripted([() => ({ content: [use('1', 'todo_write', { items: [{ text: 'a', status: 'in_progress' }] }), use('2', 'shell', { command: 'ls' })] })]);
    agent = new Agent({ box, model, approve: (c) => (c.name === 'todo_write' && agent.stop(), true) });
    const events = await collect(agent.send('go'));
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stopped' });
    expect(agent.todos).toEqual([{ text: 'a', status: 'in_progress' }]);
    const last = agent.messages.at(-1)!.content as Array<Extract<Block, { type: 'tool_result' }>>;
    expect(last.map((r) => r.tool_use_id)).toEqual(['1', '2']);
    expect(last[1]!.content).toMatch(/Not run/);
    expect(box.commands).toEqual([]);
  });

  it('reports model errors, step limits and refusals as the last event', async () => {
    const failing: Provider = { id: 'x', contextWindow: 1, turn: async () => Promise.reject(new Error('rate limited')) };
    const a = await collect(new Agent({ box: fakeBox(), model: failing }).send('hi'));
    expect(a.slice(-2)).toEqual([{ type: 'error', message: 'rate limited', retryable: false }, { type: 'done', reason: 'error', text: '' }]);
    await expect(new Agent({ box: fakeBox(), model: failing }).run('hi')).rejects.toThrow('rate limited');

    const loop = scripted(Array.from({ length: 5 }, (_, i) => () => ({ content: [use(String(i), 'shell', { command: 'true' })] })));
    expect((await collect(new Agent({ box: fakeBox(), model: loop, maxSteps: 3 }).send('go'))).at(-1)).toMatchObject({ reason: 'max_steps' });
    expect(loop.requests).toHaveLength(3);

    const refusing = scripted([() => ({ content: [], stop: 'refusal' })]);
    expect((await collect(new Agent({ box: fakeBox(), model: refusing }).send('go'))).at(-1)).toMatchObject({ reason: 'refusal' });
  });

  it('saves and restores a conversation', async () => {
    const box = fakeBox();
    const first = new Agent({ box, model: scripted([() => ({ content: [say('one')] })]) });
    expect(await first.run('hello')).toBe('one');
    const saved = JSON.parse(JSON.stringify(first));
    const model = scripted([() => ({ content: [say('two')] })]);
    const again = Agent.restore(saved, { box, model });
    expect(await again.run('more')).toBe('two');
    expect(model.requests[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(() => Agent.restore({} as never, { box, model })).toThrow(/not a saved session/);
  });

  it('refuses a second send while one is running', async () => {
    let release!: () => void;
    const slow: Provider = { id: 's', contextWindow: 1, turn: () => new Promise((r) => (release = () => r({ content: [say('x')], stop: 'end', usage: { input: 0, output: 0, cacheRead: 0 }, model: 's' }))) };
    const agent = new Agent({ box: fakeBox(), model: slow });
    const run = collect(agent.send('a'));
    expect(() => agent.send('b')).toThrow(/already working/);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await run;
    expect(agent.busy).toBe(false);
  });
});

describe('agent tools helpers', () => {
  it('matches globs', () => {
    const m = (g: string, p: string) => globToRegExp(g).test(p);
    expect(m('**/*.ts', 'a/b/c.ts')).toBe(true);
    expect(m('**/*.ts', 'c.ts')).toBe(true);
    expect(m('*.ts', 'a/c.ts')).toBe(false);
    expect(m('src/*.{js,css}', 'src/a.css')).toBe(true);
    expect(m('src/*.{js,css}', 'src/a.ts')).toBe(false);
    expect(m('file?.txt', 'file1.txt')).toBe(true);
    expect(m('a.b', 'aXb')).toBe(false);
  });

  it('normalizes paths', () => {
    expect(normalize('/home/user/./a/../b//c')).toBe('/home/user/b/c');
    expect(normalize('/../..')).toBe('/');
  });
});

describe('agent package boundary', () => {
  it('imports only its own files, the Claude SDK, and the BrowserBox SDK (types only)', () => {
    const root = join(__dirname, '../packages/agent/src');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const bad: string[] = [];
    for (const f of files(root)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/^(import(?:\s+type)?)[^'"]*['"]([^'"]+)['"]/gm)) {
        const [, kind, spec] = m;
        if (spec!.startsWith('.')) continue;
        if (spec === '@anthropic-ai/sdk') continue;
        if (spec === '@jeevanand/agent-browserbox-sdk' && kind!.includes('type')) continue;
        bad.push(`${f.slice(root.length + 1)}: ${kind} ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
