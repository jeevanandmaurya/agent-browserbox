import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { Agent, AgentOs, AGENT_HOME, type AgentEvent, type Block, type PermRequest, type Provider, type TurnRequest, type TurnResult } from '../packages/agent/src/index';
import { SEED_FILES } from '../packages/agent/src/ext/seed';

/**
 * The ported agent (packages/agent) driven by a scripted model against an
 * in-memory box with just enough of the SDK's surface. The browser e2e test
 * (scripts/sdk-e2e.mjs) runs it against a real box.
 */

type Stat = { path: string; name: string; kind: 'file' | 'dir'; size: number; mtime: number };

function fakeBox(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const dirs = new Set<string>(['/', '/home', '/home/user', AGENT_HOME, '/tmp']);
  const commands: string[] = [];
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const addDirs = (p: string) => {
    for (let d = parent(p); d !== '/'; d = parent(d)) dirs.add(d);
  };
  const enoent = (p: string) => new Error(`ENOENT: no such file or directory, '${p}'`);
  const stat = (p: string): Stat | null =>
    store.has(p) ? { path: p, name: p.split('/').pop()!, kind: 'file', size: store.get(p)!.length, mtime: 1 } : dirs.has(p) ? { path: p, name: p.split('/').pop()!, kind: 'dir', size: 0, mtime: 1 } : null;
  const children = (p: string) => [...new Set([...store.keys(), ...dirs].filter((k) => k !== p && parent(k) === p))].map((k) => stat(k)!);
  const stream = (text: string) => new ReadableStream<string>({ start: (c) => (text && c.enqueue(text), c.close()) });
  const run = (cmd: string, cwd: string) => {
    commands.push(cmd);
    if (cmd.startsWith('cd ')) return { out: '', code: 0, cwd: cmd.slice(3).startsWith('/') ? cmd.slice(3) : `${cwd}/${cmd.slice(3)}` };
    if (cmd === 'pwd') return { out: `${cwd}\n`, code: 0, cwd };
    if (cmd.startsWith('fail')) return { out: 'nope\n', code: 2, cwd };
    return { out: `ran: ${cmd}\n`, code: 0, cwd };
  };
  const box = {
    home: '/home/user',
    storage: 'memory',
    version: 'test',
    caps: ['opfs'],
    fs: {
      readFile: async (p: string) => {
        if (!store.has(p)) throw enoent(p);
        return new TextEncoder().encode(store.get(p)!);
      },
      readTextFile: async (p: string) => {
        if (!store.has(p)) throw enoent(p);
        return store.get(p)!;
      },
      writeFile: async (p: string, d: string | Uint8Array) => (addDirs(p), void store.set(p, typeof d === 'string' ? d : new TextDecoder().decode(d))),
      appendFile: async (p: string, d: string) => (addDirs(p), void store.set(p, (store.get(p) ?? '') + d)),
      readdir: async (p: string) => {
        if (!dirs.has(p)) throw enoent(p);
        return children(p);
      },
      stat: async (p: string) => stat(p),
      exists: async (p: string) => stat(p) !== null,
      mkdir: async (p: string) => (addDirs(`${p}/x`), void dirs.add(p)),
      rm: async (p: string) => {
        if (!stat(p)) throw enoent(p);
        store.delete(p);
        for (const k of [...store.keys()]) if (k.startsWith(`${p}/`)) store.delete(k);
        dirs.delete(p);
      },
      rename: async (a: string, b: string) => (addDirs(b), store.set(b, store.get(a)!), void store.delete(a)),
      cp: async (a: string, b: string) => (addDirs(b), void store.set(b, store.get(a)!)),
      glob: async (pattern: string, o: { cwd?: string } = {}) => [...store.keys()].filter((k) => k.startsWith(`${o.cwd}/`) && k.endsWith(pattern.replace(/^\*\*\/\*/, ''))),
    },
    exec: async (cmd: string) => (commands.push(cmd), { exitCode: 0, stdout: '', stderr: '' }),
    openShell: async (o: { cwd?: string } = {}) => {
      const shell = {
        cwd: o.cwd ?? '/home/user',
        run: async (cmd: string) => {
          const r = run(cmd, shell.cwd);
          return {
            stdout: stream(r.out),
            stderr: stream(''),
            exit: Promise.resolve(r.code).then((c) => ((shell.cwd = r.cwd), c)),
            kill: async () => true,
          };
        },
        close: async () => undefined,
      };
      return shell;
    },
    processes: async () => [{ pid: 7, ppid: 0, name: 'bbsh', kind: 'shell', state: 'idle', detail: '', started: 0, cpuMs: 0, memBytes: 0 }],
    killProcess: async (pid: number) => pid === 7,
    dev: { start: async () => ({ port: 3000, root: '/', url: 'http://localhost:3000/', backend: null, network: false }), stop: async () => true, list: async () => [], logs: async () => [] },
  };
  return Object.assign(box as unknown as BrowserBox, { files: store, commands });
}

type Step = (req: TurnRequest) => Partial<TurnResult> & { content: Block[] };
function scripted(steps: Step[]): Provider & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    id: 'scripted',
    contextBudget: 0,
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
const resultsOf = (req: TurnRequest) => req.messages.at(-1)!.content as Array<Extract<Block, { type: 'tool_result' }>>;

async function setup(steps: Step[], opts: { files?: Record<string, string>; settings?: Record<string, unknown>; prompter?: (r: PermRequest) => Promise<'once' | 'always' | 'deny'> } = {}) {
  const box = fakeBox(opts.files);
  const model = scripted(steps);
  const os = await AgentOs.create(box, { provider: model, settings: opts.settings, prompter: opts.prompter, seed: false });
  const events: AgentEvent[] = [];
  const agent = new Agent(os, { onEvent: (e) => events.push(e), ask: async () => 'yes' });
  return { box, model, os, agent, events };
}

describe('the ported agent', () => {
  it('runs tools in the box, reports diffs, and answers', async () => {
    const { box, model, agent, events } = await setup([
      () => ({ content: [say('On it.'), use('a', 'write_file', { path: 'notes.txt', content: 'one\ntwo' }), use('b', 'shell', { command: 'cd sub' })] }),
      () => ({ content: [use('c', 'edit_file', { path: '../notes.txt', old_string: 'two', new_string: 'three' }) /* relative to the shell's folder, now sub/ */, use('d', 'shell', { command: 'pwd' })] }),
      () => ({ content: [say('Done.')] }),
    ]);
    await agent.send('make notes');
    expect(box.files.get(`${AGENT_HOME}/notes.txt`)).toBe('one\nthree');
    // The shell session keeps its folder between calls (cd, then pwd).
    expect(resultsOf(model.requests[2]!).find((r) => r.tool_use_id === 'd')!.content).toBe(`${AGENT_HOME}/sub`);
    expect(events.filter((e) => e.type === 'file_change')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'end' });
    expect(agent.lastText()).toBe('Done.');
    expect(agent.total.input).toBe(30);
  });

  it('returns bad calls to the model as errors instead of running them', async () => {
    const { model, agent } = await setup(
      [
        () => ({ content: [use('1', 'write_file', { path: 'x' }), use('2', 'no_such_tool', {}), use('3', 'shell', {}, { invalid: '{"command":' }), use('4', 'edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }), use('5', 'shell', { command: 'fail now' })] }),
        () => ({ content: [say('ok')] }),
      ],
      { files: { [`${AGENT_HOME}/a.txt`]: 'x x' } },
    );
    await agent.send('go');
    const r = resultsOf(model.requests[1]!);
    expect(r.map((x) => [x.tool_use_id, !!x.is_error])).toEqual([['1', true], ['2', true], ['3', true], ['4', true], ['5', true]]);
    expect(r[0]!.content).toMatch(/missing required property "content"/);
    expect(r[1]!.content).toMatch(/Unknown tool/);
    expect(r[2]!.content).toMatch(/INVALID_JSON/);
    expect(r[3]!.content).toMatch(/occurs 2 times/);
    expect(r[4]!.content).toMatch(/exit code 2/);
  });

  it('asks permission for gated actions in ask mode, and respects a denial', async () => {
    const asked: string[] = [];
    const { box, model, agent } = await setup([() => ({ content: [use('1', 'shell', { command: 'ls' }), use('2', 'write_file', { path: `${AGENT_HOME}/ok.txt`, content: '1' })] }), () => ({ content: [say('ok')] })], {
      settings: { 'perms.mode': 'ask' },
      prompter: async (req) => (asked.push(req.cap), 'deny'),
    });
    await agent.send('go');
    expect(asked).toEqual(['exec']); // writing in the agent's workspace needs no grant
    expect(box.files.has(`${AGENT_HOME}/ok.txt`)).toBe(true);
    expect(resultsOf(model.requests[1]!)[0]!.content).toMatch(/denied permission/);
  });

  it('never runs a tool call from a reply cut off at max_tokens', async () => {
    const { box, model, agent } = await setup([() => ({ content: [use('1', 'write_file', { path: 'half.txt', content: 'only the first ha' })], stop: 'max_tokens' }), () => ({ content: [say('retrying')] })]);
    await agent.send('go');
    expect(box.files.has(`${AGENT_HOME}/half.txt`)).toBe(false);
    expect(resultsOf(model.requests[1]!)[0]!.content).toMatch(/cut off/);
  });

  it('rewinds the conversation and puts the files back', async () => {
    const { box, agent } = await setup(
      [() => ({ content: [use('1', 'write_file', { path: 'f.txt', content: 'changed' })] }), () => ({ content: [say('changed it')] })],
      { files: { [`${AGENT_HOME}/f.txt`]: 'original' } },
    );
    await agent.send('change f');
    expect(box.files.get(`${AGENT_HOME}/f.txt`)).toBe('changed');
    const r = await agent.rewind(0, true);
    expect(r.restored).toEqual([`${AGENT_HOME}/f.txt`]);
    expect(box.files.get(`${AGENT_HOME}/f.txt`)).toBe('original');
    expect(agent.transcript).toEqual([]);
  });

  it('compacts the conversation into a summary on request', async () => {
    const { model, agent, events } = await setup([() => ({ content: [say('hello')] }), () => ({ content: [say('Summary: said hello.')] })]);
    await agent.send('hi');
    expect(await agent.compact()).toBe(true);
    expect(agent.messages).toHaveLength(1);
    expect((agent.messages[0]!.content[0] as { text: string }).text).toMatch(/Summary: said hello\./);
    expect(agent.transcript.length).toBeGreaterThan(2); // the full history is kept for display
    expect(events.some((e) => e.type === 'compact')).toBe(true);
    expect(model.requests[1]!.tools.length).toBeGreaterThan(0);
  });

  it('offers only read-only tools in plan mode', async () => {
    const { model, agent } = await setup([() => ({ content: [say('1. do this')] })]);
    await agent.send('how would you do it?', { plan: true });
    const names = model.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('shell');
  });

  it('stops mid-run and leaves a valid conversation', async () => {
    let agent!: Agent;
    const { box, model } = await (async () => {
      const s = await setup([() => ({ content: [use('1', 'todo_write', { items: [{ text: 'a', status: 'in_progress' }] }), use('2', 'shell', { command: 'ls' })] })]);
      agent = s.agent;
      return s;
    })();
    const sending = agent.send('go');
    agent.stop();
    await sending;
    expect(model.requests.length).toBeLessThanOrEqual(1);
    const last = agent.messages.at(-1)!;
    if (last.role === 'assistant') throw new Error('dangling assistant turn');
    expect(box.commands.filter((c) => c === 'ls')).toHaveLength(0);
  });

  it('offers run_python only once the python package is installed', async () => {
    const { model, agent } = await setup([() => ({ content: [say('ok')] })]);
    await agent.send('hi');
    expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain('run_python');
  });
});

describe('agent package', () => {
  it('embeds the seed skills, agents and commands exactly as in ext/seed', () => {
    const root = join(__dirname, '../packages/agent/src/ext/seed');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const onDisk = Object.fromEntries(files(root).map((f) => [relative(root, f).split('\\').join('/'), readFileSync(f, 'utf8')]));
    expect(SEED_FILES).toEqual(onDisk);
  });

  it('imports only its own files, the Claude SDK, WebLLM, and the BrowserBox SDK (types only)', () => {
    const root = join(__dirname, '../packages/agent/src');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const bad: string[] = [];
    for (const f of files(root)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:^import(\s+type)?[^'"]*|import\()\s*['"]([^'"]+)['"]/gm)) {
        const typeOnly = !!m[1];
        const spec = m[2]!;
        if (spec.startsWith('.') || spec === '@anthropic-ai/sdk' || spec === '@mlc-ai/web-llm') continue;
        if (spec === '@jeevanand/agent-browserbox-sdk' && typeOnly) continue;
        bad.push(`${relative(root, f)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
