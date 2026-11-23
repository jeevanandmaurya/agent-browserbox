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
        () => ({ content: [use('0', 'read_file', { path: 'a.txt' })] }),
        () => ({ content: [use('1', 'write_file', { path: 'x' }), use('2', 'no_such_tool', {}), use('3', 'shell', {}, { invalid: '{"command":' }), use('4', 'edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }), use('5', 'shell', { command: 'fail now' })] }),
        () => ({ content: [say('ok')] }),
      ],
      { files: { [`${AGENT_HOME}/a.txt`]: 'x x' } },
    );
    await agent.send('go');
    const r = resultsOf(model.requests[2]!);
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
      [() => ({ content: [use('0', 'read_file', { path: 'f.txt' })] }), () => ({ content: [use('1', 'write_file', { path: 'f.txt', content: 'changed' })] }), () => ({ content: [say('changed it')] })],
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

  it('sends attached images to the model and lets it look at image files', async () => {
    const png = `${AGENT_HOME}/shot.png`;
    const { model, agent } = await setup(
      [
        (req) => {
          const first = req.messages[0]!.content;
          expect(first.find((b) => b.type === 'image')).toMatchObject({ path: png, mediaType: 'image/png', data: btoa('PNGDATA') });
          return { content: [use('v', 'view_image', { path: 'chart.webp' })] };
        },
        (req) => {
          const r = resultsOf(req).find((b) => b.tool_use_id === 'v')!;
          expect(r.images?.[0]).toMatchObject({ path: `${AGENT_HOME}/chart.webp`, mediaType: 'image/webp', data: btoa('WEBP') });
          return { content: [say('A chart.')] };
        },
      ],
      { files: { [png]: 'PNGDATA', [`${AGENT_HOME}/chart.webp`]: 'WEBP' } },
    );
    await agent.send('what is this?', { images: [png, `${AGENT_HOME}/notes.txt`] });
    expect(model.requests).toHaveLength(2);
    // Image data goes to the model but is not kept in the conversation.
    expect(JSON.stringify(agent.messages)).not.toContain(btoa('PNGDATA'));
    expect(agent.messages[0]!.content.some((b) => b.type === 'text' && b.text.includes('not a PNG, JPEG, GIF or WebP'))).toBe(true);
  });

  it('applies permission rules before the permission mode', async () => {
    const asked: string[] = [];
    const { model, agent, box } = await setup(
      [
        () => ({ content: [use('a', 'shell', { command: 'git status && ls' }), use('b', 'shell', { command: 'rm -rf /home/user' }), use('c', 'shell', { command: 'curl https://x.test' }), use('d', 'shell', { command: 'git log; npm test' })] }),
        () => ({ content: [say('ok')] }),
      ],
      {
        settings: {
          'perms.mode': 'ask',
          'perms.rules': [
            { scope: 'shell', pattern: 'git *', action: 'allow' },
            { scope: 'shell', pattern: 'ls', action: 'allow' },
            { scope: 'shell', pattern: 'rm -rf *', action: 'deny' },
            { scope: 'shell', pattern: 'curl *', action: 'ask' },
          ],
        },
        prompter: async (r) => (asked.push(r.detail), 'once'),
      },
    );
    await agent.send('go');
    const results = resultsOf(model.requests[1]!);
    expect(results.find((r) => r.tool_use_id === 'a')!.is_error).toBeFalsy();
    expect(results.find((r) => r.tool_use_id === 'b')!.content).toMatch(/Blocked by the user's permission rule "deny command rm -rf \*"/);
    expect(box.commands).not.toContain('rm -rf /home/user');
    // Only the ask rule and the partly-allowed command line prompted.
    expect(asked).toEqual(['curl https://x.test', 'git log; npm test']);
  });

  it('runs edits one after another, so two edits of one file both land', async () => {
    const f = `${AGENT_HOME}/a.txt`;
    const { box, model, agent } = await setup(
      [
        () => ({ content: [use('0', 'read_file', { path: 'a.txt' })] }),
        () => ({ content: [use('1', 'edit_file', { path: 'a.txt', old_string: 'one', new_string: 'ONE' }), use('2', 'edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' })] }),
        () => ({ content: [say('ok')] }),
      ],
      { files: { [f]: 'one two' } },
    );
    await agent.send('edit');
    expect(box.files.get(f)).toBe('ONE TWO');
    expect(resultsOf(model.requests[2]!).every((r) => !r.is_error)).toBe(true);
  });

  it('asks before deleting the workspace or its saved chats, and keeps downloads in it', async () => {
    const asked: string[] = [];
    const { model, agent, box } = await setup(
      [
        () => ({ content: [use('d', 'delete_path', { path: '.' }), use('s', 'delete_path', { path: '.sessions' }), use('f', 'delete_path', { path: 'scratch.txt' }), use('h', 'http_fetch', { url: 'https://x.test/a', save_to: '/home/user/.profile' })] }),
        () => ({ content: [say('ok')] }),
      ],
      { files: { [`${AGENT_HOME}/scratch.txt`]: 'x', [`${AGENT_HOME}/.sessions/s.json`]: '{}' }, settings: { 'perms.mode': 'ask', 'perms.grants': ['net'] }, prompter: async (r) => (asked.push(r.detail), 'deny') },
    );
    await agent.send('clean up');
    expect(asked).toEqual(['Delete .', 'Delete .sessions']);
    expect(box.files.has(`${AGENT_HOME}/scratch.txt`)).toBe(false);
    const h = resultsOf(model.requests[1]!).find((r) => r.tool_use_id === 'h')!;
    expect(h.is_error && h.content).toMatch(/save_to must be inside/);
  });

  it('keeps plan mode read-only, http_fetch included', async () => {
    const { model, agent } = await setup([() => ({ content: [use('p', 'http_fetch', { url: 'https://x.test/api', method: 'POST', body: '{}' })] }), () => ({ content: [say('plan')] })]);
    await agent.send('look', { plan: true });
    expect(resultsOf(model.requests[1]!)[0]!.content).toMatch(/Plan mode only looks/);
  });

  it('rebuilds the system prompt when the extra instructions change', async () => {
    const { model, agent, os } = await setup([() => ({ content: [say('a')] }), () => ({ content: [say('b')] })]);
    await agent.send('one');
    os.settings.set('agent.config', { ...(os.settings.get('agent.config', {}) as object), instructions: 'Answer in French.' });
    await agent.send('two');
    expect(model.requests[0]!.system).not.toContain('Answer in French.');
    expect(model.requests[1]!.system).toContain('Answer in French.');
  });

  it('refuses to edit a file it has not read, or one that changed since', async () => {
    const f = `${AGENT_HOME}/doc.md`;
    const { model, agent, box } = await setup(
      [
        () => ({ content: [use('a', 'edit_file', { path: 'doc.md', old_string: 'v1', new_string: 'v2' }), use('n', 'write_file', { path: 'new.md', content: 'fresh' })] }),
        () => ({ content: [use('r', 'read_file', { path: 'doc.md' })] }),
        () => {
          box.files.set(f, 'v1 edited by the user');
          return { content: [use('b', 'edit_file', { path: 'doc.md', old_string: 'v1', new_string: 'v2' })] };
        },
        () => ({ content: [use('r2', 'read_file', { path: 'doc.md' }), use('c', 'edit_file', { path: 'doc.md', old_string: 'v1', new_string: 'v2' })] }),
        () => ({ content: [say('done')] }),
      ],
      { files: { [f]: 'v1' } },
    );
    await agent.send('update the doc');
    const first = resultsOf(model.requests[1]!);
    expect(first.find((r) => r.tool_use_id === 'a')!.content).toMatch(/Read \/home\/agent\/doc.md first/);
    expect(first.find((r) => r.tool_use_id === 'n')!.is_error).toBeFalsy(); // a new file needs no read
    expect(resultsOf(model.requests[3]!)[0]!.content).toMatch(/changed since you last read it/);
    expect(resultsOf(model.requests[4]!).every((r) => !r.is_error)).toBe(true);
    expect(box.files.get(f)).toBe('v2 edited by the user');
  });

  it('accepts file edits without asking in edits mode, but not commands or the user\'s real folders', async () => {
    const asked: string[] = [];
    const { box, agent } = await setup(
      [
        () => ({ content: [use('w', 'write_file', { path: '/home/user/notes.md', content: 'hi' }), use('m', 'write_file', { path: '/mnt/laptop/x.md', content: 'hi' }), use('s', 'shell', { command: 'ls' })] }),
        () => ({ content: [say('ok')] }),
      ],
      { settings: { 'perms.mode': 'edits' }, prompter: async (r) => (asked.push(r.detail), 'once') },
    );
    await agent.send('write');
    expect(box.files.get('/home/user/notes.md')).toBe('hi');
    expect(asked).toEqual(['Write /mnt/laptop/x.md (2 chars)', 'ls']);
  });

  it('runs sub-agents asked for together at the same time, each with its own model and kept transcript', async () => {
    const box = fakeBox();
    await box.fs.writeFile(`${AGENT_HOME}/agents/explorer.md`, '---\ndescription: looks around\nmodel: fast-model\n---\nExplore.');
    let running = 0;
    let most = 0;
    const models: string[] = [];
    let os!: AgentOs;
    const provider: Provider = {
      id: 'scripted',
      contextBudget: 0,
      contextWindow: 100_000,
      async turn(req) {
        const last = req.messages.at(-1)!;
        const text = last.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        const usage = { input: 1, output: 1, cacheRead: 0 };
        if (text.startsWith('task ')) {
          running++;
          most = Math.max(most, running);
          models.push(...os.procs.list().filter((p) => p.name !== 'agent').map((p) => p.detail));
          await new Promise((r) => setTimeout(r, 200));
          running--;
          return { content: [say(`${text} done`)], stop: 'end', usage, model: 'm' };
        }
        if (last.content.some((b) => b.type === 'tool_result')) return { content: [say('all done')], stop: 'end', usage, model: 'm' };
        return { content: [use('s1', 'spawn_agent', { task: 'task one', agent: 'explorer' }), use('s2', 'spawn_agent', { task: 'task two' }), use('s3', 'spawn_agent', { task: 'task three' })], stop: 'tool_use', usage, model: 'm' };
      },
    };
    os = await AgentOs.create(box, { provider, seed: false, settings: { 'agent.config': { provider: 'api', apiBaseUrl: 'https://api.test/v1', apiModel: 'main-model', subagentModel: 'sub-model' } } });
    const agent = new Agent(os, { onEvent: () => undefined, ask: async () => 'yes' });
    await agent.send('explore three things');
    expect(most).toBe(3);
    expect(agent.lastText()).toBe('all done');
    expect(models.some((d) => d.startsWith('fast-model'))).toBe(true); // the explorer's own model
    expect(models.some((d) => d.startsWith('sub-model'))).toBe(true); // the sub-agent model setting
    expect(Object.keys(agent.subagents).sort()).toEqual(['s1', 's2', 's3']);
    expect(agent.subagents.s2!.at(-1)!.content).toEqual([say('task two done')]);
  });

  describe('hooks', () => {
    const hook = (event: string, command: string, matcher?: string) => ({ id: event + command, event, command, matcher, enabled: true });

    it('blocks a tool before it runs, and adds output after one', async () => {
      const { model, agent, box } = await setup(
        [() => ({ content: [use('s', 'shell', { command: 'rm -rf /home/user' }), use('r', 'read_file', { path: 'a.txt' })] }), () => ({ content: [say('ok')] })],
        { files: { [`${AGENT_HOME}/a.txt`]: 'hi' }, settings: { 'agent.hooks': [hook('PreToolUse', 'fail no deleting', 'shell'), hook('PostToolUse', 'lint $BBX_FILE', 'read_file|edit_*')] } },
      );
      await agent.send('go');
      const r = resultsOf(model.requests[1]!);
      expect(r.find((x) => x.tool_use_id === 's')!.content).toMatch(/Blocked by a hook: nope/);
      expect(box.commands).not.toContain('rm -rf /home/user');
      expect(r.find((x) => x.tool_use_id === 'r')!.content).toContain(`[hook output]\nran: lint '${AGENT_HOME}/a.txt'`);
    });

    it('adds context on session start and to messages, or blocks a message', async () => {
      const { model, agent } = await setup([() => ({ content: [say('hello')] })], { settings: { 'agent.hooks': [hook('SessionStart', 'git status'), hook('UserPromptSubmit', 'date')] } });
      await agent.send('hi');
      const first = model.requests[0]!.messages[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(first).toContain('<hook-context>\nran: git status\n\nran: date\n</hook-context>');

      const blocked = await setup([], { settings: { 'agent.hooks': [hook('UserPromptSubmit', 'fail not now')] } });
      await blocked.agent.send('hi');
      expect(blocked.model.requests).toHaveLength(0);
      expect(blocked.events.some((e) => e.type === 'note' && e.text.includes('A hook blocked this message: nope'))).toBe(true);
    });

    it('sends the agent back to work from a Stop hook, at most 3 times', async () => {
      const { model, agent, events } = await setup([() => ({ content: [say('done')] }), () => ({ content: [say('fixed')] }), () => ({ content: [say('fixed again')] }), () => ({ content: [say('really done')] })], {
        settings: { 'agent.hooks': [hook('Stop', 'fail tests fail')] },
      });
      await agent.send('do it');
      expect(model.requests).toHaveLength(4);
      expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain('A Stop hook asks you to keep going');
      expect(events.filter((e) => e.type === 'hook')).toHaveLength(3);
    });
  });

  describe('projects and memory', () => {
    it('works in the project folder: its AGENTS.md, writes free there, and its chats listed apart', async () => {
      const box = fakeBox();
      await box.fs.writeFile('/home/user/Projects/Site/AGENTS.md', 'Use tabs.');
      const model = scripted([() => ({ content: [use('w', 'write_file', { path: 'index.html', content: '<h1>' }), use('o', 'write_file', { path: '/home/agent/x.txt', content: 'x' })] }), () => ({ content: [say('built')] })]);
      const asked: string[] = [];
      const os = await AgentOs.create(box, { provider: model, seed: false, settings: { 'perms.mode': 'ask' }, prompter: async (r) => (asked.push(r.detail), 'deny') });
      const { createProject, listSessions, AgentManager } = await import('../packages/agent/src/index');
      const site = await createProject(os, { name: 'Site', folder: '/home/user/Projects/Site' });
      const agents = new AgentManager(os);
      const chat = await agents.create({ project: site.id });
      await chat.send('build it');
      expect(model.requests[0]!.system).toContain('Use tabs.');
      expect(model.requests[0]!.system).toContain('Your working directory is /home/user/Projects/Site (the folder of the project "Site")');
      expect(box.files.get('/home/user/Projects/Site/index.html')).toBe('<h1>');
      expect(asked).toEqual(['Write /home/agent/x.txt (1 chars)']); // outside the project: asks
      await new Promise((r) => setTimeout(r, 20));
      expect((await listSessions(os, site.id)).map((s) => s.project)).toEqual(['site']);
      expect(await listSessions(os, 'general')).toEqual([]);
      expect((await chat.snapshot()).project).toBe('site');
    });

    it('rebuilds the session index from the files when it is missing', async () => {
      const box = fakeBox();
      await box.fs.writeFile(`${AGENT_HOME}/.sessions/a.json`, JSON.stringify({ id: 'a', title: 'old chat', updated: 5, messages: [], todos: [] }));
      const { listSessions } = await import('../packages/agent/src/index');
      const os = await AgentOs.create(box, { seed: false });
      expect(await listSessions(os)).toEqual([{ id: 'a', title: 'old chat', updated: 5, project: 'general' }]);
      expect(box.files.has(`${AGENT_HOME}/.sessions/index.json`)).toBe(true);
    });

    it('remembers one entry at a time, per scope, within a budget, and the next chat sees it', async () => {
      const { model, agent, box } = await setup([
        () => ({ content: [use('a', 'memory', { action: 'add', scope: 'user', text: 'Prefers British English' }), use('b', 'memory', { action: 'add', text: 'Builds with build --prod' })] }),
        () => ({ content: [use('c', 'memory', { action: 'replace', scope: 'user', old: 'British', text: 'Prefers British spelling' }), use('d', 'memory', { action: 'remove', text: 'nothing like this' })] }),
        () => ({ content: [say('saved')] }),
      ]);
      await agent.send('remember things');
      const user = box.files.get(`${AGENT_HOME}/MEMORY.md`)!;
      expect(user).toMatch(/^# Memory[\s\S]*- Prefers British spelling \(\d{4}-\d{2}-\d{2}\)\n$/);
      expect(box.files.get(`${AGENT_HOME}/.memory/general.md`)).toContain('- Builds with build --prod');
      expect(resultsOf(model.requests[2]!).find((r) => r.tool_use_id === 'd')!.content).toMatch(/No memory entry contains/);
      expect(agent.diffs.a).toBeDefined(); // a memory change is a file change: shown and undoable

      const { addMemory } = await import('../packages/agent/src/index');
      const { AgentOs: A } = await import('../packages/agent/src/index');
      const os2 = await A.create(box, { seed: false });
      await expect(addMemory(os2, 'user', 'general', 'x'.repeat(7000))).rejects.toThrow(/memory is full/);
      const next = await setup([() => ({ content: [say('hi')] })], { files: Object.fromEntries(box.files) });
      await next.agent.send('hello');
      expect(next.model.requests[0]!.system).toContain('# Memory: about the user\n- Prefers British spelling');
      expect(next.model.requests[0]!.system).toContain('# Memory: this project\n- Builds with build --prod');
    });

    it('offers no memory tool when the user turned automatic memories off', async () => {
      const { model, agent } = await setup([() => ({ content: [say('ok')] })], { settings: { 'agent.memory.auto': false } });
      await agent.send('hi');
      expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain('memory');
    });
  });

  it('makes artifacts with versions, edits the latest, and rewinding removes them', async () => {
    const { model, agent, box } = await setup([
      () => ({ content: [use('a', 'create_artifact', { title: 'Q3 Report', kind: 'markdown', content: '# Q3\nSales up.' })] }),
      () => ({ content: [use('b', 'update_artifact', { id: 'q3-report', edits: [{ old: 'Sales up.', new: 'Sales up 12%.' }], note: 'number' })] }),
      () => ({ content: [use('c', 'read_artifact', {}), use('d', 'read_artifact', { id: 'q3-report', version: 1 })] }),
      () => ({ content: [say('here it is')] }),
    ]);
    await agent.send('write the report');
    const dir = `${AGENT_HOME}/.artifacts/q3-report`;
    expect(resultsOf(model.requests[1]!)[0]!.content).toBe('Created artifact "Q3 Report" (id: q3-report, kind: markdown, version 1).');
    expect(box.files.get(`${dir}/v2.md`)).toBe('# Q3\nSales up 12%.');
    const meta = JSON.parse(box.files.get(`${dir}/artifact.json`)!);
    expect(meta.versions.map((v: { n: number; note?: string }) => [v.n, v.note])).toEqual([[1, undefined], [2, 'number']]);
    expect(meta.session).toBe(agent.id);
    const list = resultsOf(model.requests[3]!);
    expect(list[0]!.content).toBe('q3-report · markdown · v2 · Q3 Report');
    expect(list[1]!.content).toContain('version 1 of 2');
    await agent.rewind(0, true);
    expect([...box.files.keys()].some((k) => k.startsWith(dir))).toBe(false);
  });
});
