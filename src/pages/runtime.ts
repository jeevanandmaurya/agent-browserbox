import { saveConfig, SECRET, type AgentConfig } from '@/agent/config';
import { connectKernel } from '@/client/connect';
import { RemoteKernel } from '@/client/remote-kernel';
import type { AgentHandle, ShellHandle } from '@/kernel/api';
import type { PermRequest } from '@/kernel/perms';
import { ALLOWED_ORIGINS } from '@/config/origins';
import { AGENT_HOME } from '@/kernel/paths';
import { dirname } from '@/kernel/vfs/path';
import { mayConnect } from '@/sdk/origin-policy';
import { PROTOCOL, type ClientMsg, type ProcEvent, type RuntimeMsg } from '@/sdk/protocol';

/**
 * The runtime: a UI-less page that owns the kernel and serves it to the
 * BrowserBox SDK (`@jeevanand/browserbox`) in the embedding page.
 *
 * Only this page needs the kernel, the worker and the wasm; the embedding app
 * loads a few KB of client code and talks to it over a MessagePort.
 *
 * Who may connect: the runtime runs in a frame, so its storage belongs to the
 * embedding site (browsers partition third-party storage). A cross-site
 * embedder gets its own empty sandbox and can never see the files or keys of
 * someone using BrowserBox directly. A same-site embedder would share them, so
 * those must be listed in VITE_ALLOWED_ORIGINS. Loopback hosts are allowed
 * (local development).
 */
const os = new RemoteKernel(connectKernel());
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;
/** The SDK's home folder is the agent's workspace, so the agent sees what the app writes. */
const HOME = AGENT_HOME;

/** One connected SDK client. */
function serve(port: MessagePort): void {
  const send = (msg: RuntimeMsg, transfer: Transferable[] = []) => port.postMessage(msg, transfer);
  const procs = new Map<number, { shell: ShellHandle; ctl: AbortController; input: string[]; waiting?: (line: string | null) => void }>();
  const agents = new Map<string, AgentHandle>();
  const asks = new Map<number, (v: unknown) => void>();
  let nextAsk = 1;
  const ask = (kind: 'perm' | 'question', payload: unknown, sid?: string) =>
    new Promise<unknown>((resolve) => {
      const id = nextAsk++;
      asks.set(id, resolve);
      send({ t: 'ask', id, kind, sid, payload });
    });

  async function mkdirp(path: string): Promise<void> {
    if (path === '/' || (await os.fs.exists(path))) return;
    await mkdirp(dirname(path));
    await os.fs.mkdir(path).catch(async (err: Error) => {
      if (!(await os.fs.exists(path))) throw err;
    });
  }
  type Tree = Record<string, { file: { contents: string | Uint8Array } } | { directory: Tree } | { symlink: string }>;
  async function mount(tree: Tree, at: string): Promise<number> {
    let n = 0;
    await mkdirp(at);
    for (const [name, node] of Object.entries(tree)) {
      if (!name || name.includes('/') || name === '.' || name === '..') throw new Error(`Bad name in file tree: "${name}"`);
      const path = `${at === '/' ? '' : at}/${name}`;
      if ('directory' in node) n += await mount(node.directory, path);
      else if ('file' in node) {
        await os.fs.writeFile(path, node.file.contents);
        n++;
      }
    }
    return n;
  }
  const abs = (p: unknown) => {
    const s = String(p);
    return s.startsWith('/') ? s : `${HOME}/${s.replace(/^\.\//, '')}`;
  };

  const methods: Record<string, (...a: any[]) => unknown> = {
    'fs.readFile': async (p) => {
      const bytes = await os.fs.readFile(abs(p));
      return bytes;
    },
    'fs.readText': (p) => os.fs.readText(abs(p)),
    'fs.writeFile': async (p, data) => {
      await mkdirp(dirname(abs(p)));
      await os.fs.writeFile(abs(p), data);
    },
    'fs.appendFile': (p, data) => os.fs.appendFile(abs(p), data),
    'fs.readdir': (p) => os.fs.readdir(abs(p)),
    'fs.stat': (p) => os.fs.stat(abs(p)),
    'fs.exists': (p) => os.fs.exists(abs(p)),
    'fs.mkdir': (p, o?: { recursive?: boolean }) => (o?.recursive ? mkdirp(abs(p)) : os.fs.mkdir(abs(p))),
    'fs.rm': (p, o?: { recursive?: boolean; force?: boolean }) =>
      os.fs.rm(abs(p), { recursive: o?.recursive }).catch((err: Error) => {
        if (!o?.force) throw err;
      }),
    'fs.cp': (a, b) => os.fs.cp(abs(a), abs(b)),
    'fs.rename': (a, b) => os.fs.mv(abs(a), abs(b)),
    'fs.glob': (pattern, cwd?: string) => os.fs.glob(String(pattern), cwd ? abs(cwd) : HOME),
    'fs.mount': (tree: Tree, at?: string) => mount(tree, abs(at ?? HOME)),

    'proc.spawn': async (id: number, line: string, o?: { cwd?: string }) => {
      const shell = await os.shells.open({ cwd: o?.cwd ? abs(o.cwd) : HOME });
      const p = { shell, ctl: new AbortController(), input: [] as string[], waiting: undefined as ((line: string | null) => void) | undefined };
      procs.set(id, p);
      const ev = (d: ProcEvent) => send({ t: 'ev', ch: `proc:${id}`, d });
      // Commands that read from the terminal get what the client writes, line by line.
      shell.onReadLine(
        (prompt) =>
          new Promise((resolve) => {
            if (prompt) ev({ k: 'out', s: prompt });
            const next = p.input.shift();
            if (next !== undefined) resolve(next);
            else p.waiting = resolve;
          }),
      );
      void shell
        .run(line, { out: (s) => ev({ k: 'out', s }), err: (s) => ev({ k: 'err', s }), signal: p.ctl.signal })
        .catch((err: Error) => (ev({ k: 'err', s: `${err.message}\n` }), 1))
        .then((code) => {
          ev({ k: 'exit', code });
          procs.delete(id);
          p.waiting?.(null);
          shell.close();
        });
    },
    'proc.write': (id: number, text: string) => {
      const p = procs.get(id);
      if (!p) return;
      const lines = String(text).split('\n');
      const last = lines.pop()!; // text after the last newline waits for more
      if (last) lines.push(last);
      for (const l of lines) {
        if (p.waiting) {
          const w = p.waiting;
          p.waiting = undefined;
          w(l);
        } else p.input.push(l);
      }
    },
    'proc.kill': (id: number) => procs.get(id)?.ctl.abort(),

    'agent.configure': async (c: { provider: AgentConfig['provider']; model?: string; baseUrl?: string; apiKey?: string; mode?: 'auto' | 'ask' }) => {
      const patch: Partial<AgentConfig> = { provider: c.provider };
      if (c.provider === 'anthropic' && c.model) patch.anthropicModel = c.model;
      if (c.provider === 'local') Object.assign(patch, c.model ? { localModel: c.model } : {}, c.baseUrl ? { localBaseUrl: c.baseUrl } : {});
      if (c.provider === 'openai') Object.assign(patch, c.model ? { openaiModel: c.model } : {}, c.baseUrl ? { openaiBaseUrl: c.baseUrl } : {});
      if (c.provider === 'webllm' && c.model) patch.webllmModel = c.model;
      saveConfig(os, patch);
      if (c.apiKey !== undefined && c.provider !== 'webllm') await os.secrets.set(SECRET[c.provider], c.apiKey);
      if (c.mode) os.perms.mode = c.mode;
    },
    'agent.create': async (o?: { private?: boolean; resume?: string }) => {
      const a = await os.agents.create({ private: o?.private ?? true, resume: o?.resume });
      agents.set(a.sid, a);
      a.onEvent((d) => send({ t: 'ev', ch: `agent:${a.sid}`, d }));
      a.onAsk(async (question, options) => String((await ask('question', { question, options }, a.sid)) ?? ''));
      a.prompter = async (req: PermRequest) => {
        const v = await ask('perm', req, a.sid);
        return v === 'always' || v === 'deny' ? v : v === 'once' || v === true ? 'once' : 'deny';
      };
      return { sid: a.sid };
    },
    'agent.send': (sid: string, text: string, o?: { plan?: boolean }) => agent(sid).send(String(text), o),
    'agent.stop': (sid: string) => agent(sid).stop(),
    'agent.snapshot': async (sid: string) => {
      const s = await agent(sid).snapshot();
      return { sid: s.sid, title: s.title, busy: s.busy, messages: s.messages, total: s.total, context: s.context, todos: s.todos };
    },
    'agent.dispose': (sid: string) => {
      agent(sid).dispose();
      agents.delete(sid);
    },

    'settings.get': (k: string) => os.settings.get(String(k), null),
    'settings.set': (k: string, v: unknown) => os.settings.set(String(k), v),
  };
  const agent = (sid: string) => {
    const a = agents.get(sid);
    if (!a) throw new Error(`No agent session ${sid} (it was disposed).`);
    return a;
  };

  port.onmessage = (e: MessageEvent<ClientMsg>) => {
    const msg = e.data;
    if (msg?.t === 'answer') {
      asks.get(msg.id)?.(msg.v);
      asks.delete(msg.id);
      return;
    }
    if (msg?.t !== 'call') return;
    const fn = methods[msg.m];
    Promise.resolve()
      .then(() => {
        if (!fn) throw new Error(`Unknown method ${msg.m}. Update the SDK and the runtime together.`);
        return fn(...msg.a);
      })
      .then(
        (v) => send({ t: 'res', id: msg.id, ok: true, v: v ?? null }, v instanceof Uint8Array ? [v.buffer] : []),
        (err: Error & { code?: string }) => send({ t: 'res', id: msg.id, ok: false, e: err?.message ?? String(err), code: err?.code ?? /^(E[A-Z]+):/.exec(err?.message ?? '')?.[1] }),
      );
  };
  // A client that goes away leaves nothing running.
  port.addEventListener('close', () => {
    for (const p of procs.values()) p.ctl.abort();
    for (const a of agents.values()) a.dispose();
  });

  void os.fs.ready.then(
    () =>
      send({
        t: 'ready',
        info: { protocol: PROTOCOL, version: os.version, storage: os.rootKind, isolated: globalThis.crossOriginIsolated === true, caps: os.caps.filter((c) => c.ok).map((c) => c.id), home: HOME },
      }),
  );
}

addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as { type?: string; protocol?: number } | null;
  if (msg?.type !== 'bbx:sdk-hello' || !e.ports[0]) return;
  const port = e.ports[0];
  if (!mayConnect(e.origin, location.origin, ALLOWED_ORIGINS)) {
    port.postMessage({ t: 'refused', reason: `This BrowserBox runtime does not serve ${e.origin}: it is on the same site as the runtime, so it would share its files and keys. Build the runtime with VITE_ALLOWED_ORIGINS=${e.origin}, or host your app on another site.` });
    return;
  }
  if (msg.protocol !== PROTOCOL) {
    port.postMessage({ t: 'refused', reason: `The SDK speaks protocol ${msg.protocol}, this runtime ${PROTOCOL}. Use matching versions (or let the SDK use its default runtime URL).` });
    return;
  }
  serve(port);
  port.start();
});

if (parent !== window) parent.postMessage({ type: 'bbx:runtime-ready', protocol: PROTOCOL }, '*');
