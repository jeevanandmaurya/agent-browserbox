import type { AgentHandle, ShellHandle } from '@/kernel/api';
import type { KernelCore } from '@/kernel/kernel';
import type { PermDecision, PermRequest } from '@/kernel/perms';
import type { Proc } from '@/kernel/proc';
import type { KernelEvents, KernelLogLine } from '@/kernel/types';
import { Peer } from '@/rpc/peer';
import type { DevStartOptions, WireRequest } from '@/kernel/dev/types';
import { setSandboxHost, type BackendOp, type BackendPayload, type RunOptions, type RunResult } from '@/sandbox/sandbox';

/** What a window receives when it connects. */
export interface Hello {
  clientId: number;
  /** Pids this client may allocate for its own processes start here. */
  pidBase: number;
  version: string;
  rootKind: 'opfs' | 'memory';
  shared: boolean;
  settings: Array<[string, unknown]>;
  procs: WireProc[];
  mounts: Array<{ point: string; label: string; readonly: boolean }>;
  bootMarks: Array<{ name: string; at: number }>;
  log: KernelLogLine[];
}

/** Each window allocates pids for its own processes from a private block. */
export const PID_BLOCK = 100_000;

export type WireProc = Omit<Proc, 'signal'>;
export type AskKind = 'perm' | 'user' | 'tty' | 'ui';
export interface Ask {
  askId: number;
  kind: AskKind;
  sid?: string;
  shellId?: string;
  payload: unknown;
}

interface Client {
  id: number;
  peer: Peer;
  /** 'new' until the client says hello. Only 'ui' clients are windows a person can see. */
  role: 'ui' | 'host' | 'new';
  agents: Map<string, AgentHandle>;
  shells: Map<string, ShellHandle>;
}

const wire = (p: Proc): WireProc => ({ pid: p.pid, ppid: p.ppid, name: p.name, kind: p.kind, started: p.started, state: p.state, detail: p.detail, cpuMs: p.cpuMs, memBytes: p.memBytes });
const FORWARDED: Array<keyof KernelEvents> = ['fs:change', 'settings:change', 'notify', 'app:open', 'kmsg', 'dev:update', 'dev:log'];

/**
 * Exposes the kernel to windows over message ports. Each connection is a
 * client; the kernel never trusts a client with more than the methods below
 * (notably, secrets can be written but not read).
 */
export class KernelServer {
  #clients = new Map<number, Client>();
  #nextClient = 1;
  #nextAsk = 1;
  #nextRun = 1;
  #asks = new Map<number, { ask: Ask; resolve: (v: unknown) => void; targets: Set<number> }>();
  #runs = new Map<number, RunOptions>();
  /** Suppresses echoing an event back to the client that caused it. */
  #origin: number | null = null;

  constructor(
    private os: KernelCore,
    private shared: boolean,
  ) {
    for (const type of FORWARDED) os.bus.on(type, (payload) => this.#broadcast('bus', { type, payload }, this.#origin));
    os.bus.on('proc:spawn', (p) => this.#broadcast('bus', { type: 'proc:spawn', payload: wire(p) }));
    os.bus.on('proc:update', (p) => this.#broadcast('bus', { type: 'proc:update', payload: wire(p) }));
    os.bus.on('proc:exit', ({ proc, reason }) => this.#broadcast('bus', { type: 'proc:exit', payload: { proc: wire(proc), reason } }));

    os.perms.setPrompter((req, signal) => this.#ask<PermDecision>({ kind: 'perm', payload: req }, signal).catch(() => 'deny'));
    // Clipboard and speech happen in exactly one window.
    os.ui = { call: (method, ...args) => this.#ask({ kind: 'ui', payload: { method, args } }, undefined, [...this.#clients.values()].find((c) => c.role === 'ui')) as Promise<never> };
    setSandboxHost({ run: (kind, payload, opts) => this.#hostRun(kind, payload, opts), backend: (op, id, payload, opts) => this.#hostBackend(op, id, payload, opts), node: (job, opts) => this.#hostNode(job, opts) });
  }

  #broadcast(name: string, payload: unknown, except: number | null = null): void {
    for (const c of this.#clients.values()) if (c.id !== except && c.role === 'ui') c.peer.emit(name, payload);
  }

  /** Asks windows something and waits for the first answer. */
  #ask<T>(ask: Omit<Ask, 'askId'>, signal?: AbortSignal, only?: Client): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const askId = this.#nextAsk++;
      const full: Ask = { ...ask, askId };
      const targets = only ? [only] : [...this.#clients.values()].filter((c) => c.role === 'ui');
      if (!targets.length) return reject(new Error('no window is connected to answer'));
      const done = (v: unknown) => {
        if (!this.#asks.delete(askId)) return;
        for (const c of targets) c.peer.emit('ask:done', askId);
        resolve(v as T);
      };
      this.#asks.set(askId, { ask: full, resolve: done, targets: new Set(targets.map((c) => c.id)) });
      signal?.addEventListener('abort', () => {
        if (this.#asks.delete(askId)) {
          for (const c of targets) c.peer.emit('ask:done', askId);
          reject(signal.reason);
        }
      });
      for (const c of targets) c.peer.emit('ask', full);
    });
  }

  async #hostRun(kind: string, payload: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    const host = [...this.#clients.values()].find((c) => c.role === 'host');
    if (!host) return { ok: false, stdout: '', stderr: '', ms: 0, error: 'No window is open to host the sandbox. Open the agent window or the desktop.' };
    const runId = this.#nextRun++;
    this.#runs.set(runId, opts);
    const abort = () => host.peer.emit('host:abort', runId);
    opts.signal?.addEventListener('abort', abort);
    try {
      return await host.peer.call<RunResult>('host.run', runId, kind, payload, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    } catch (err) {
      return { ok: false, stdout: '', stderr: '', ms: 0, error: `sandbox host failed: ${(err as Error).message}` };
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      this.#runs.delete(runId);
    }
  }

  async #hostNode(job: import('@/kernel-host/node-host').NodeJob, opts: RunOptions): Promise<{ code: number }> {
    const host = [...this.#clients.values()].find((c) => c.role === 'host');
    if (!host) throw new Error('Node.js runs in a window: open the agent window or the desktop.');
    const runId = this.#nextRun++;
    this.#runs.set(runId, opts);
    const abort = () => host.peer.emit('host:abort', runId);
    opts.signal?.addEventListener('abort', abort);
    try {
      return await host.peer.call<{ code: number }>('host.node', runId, job);
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      this.#runs.delete(runId);
    }
  }

  async #hostBackend(op: BackendOp, id: string, payload: BackendPayload, opts: RunOptions): Promise<RunResult> {
    const host = [...this.#clients.values()].find((c) => c.role === 'host');
    if (!host) return { ok: false, stdout: '', stderr: '', ms: 0, error: op === 'request' ? 'backend not loaded' : 'No window is open to host the backend. Open the agent window or the desktop.' };
    const runId = this.#nextRun++;
    this.#runs.set(runId, opts);
    try {
      return await host.peer.call<RunResult>('host.backend', runId, op, id, payload, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    } catch (err) {
      return { ok: false, stdout: '', stderr: '', ms: 0, error: `sandbox host failed: ${(err as Error).message}` };
    } finally {
      this.#runs.delete(runId);
    }
  }

  /** Accepts a new connection from a window (or from a window's sandbox host). */
  connect(port: MessagePort): void {
    const peer = new Peer(port);
    const client: Client = { id: this.#nextClient++, peer, role: 'new', agents: new Map(), shells: new Map() };
    const os = this.os;
    const fs = os.fs;
    const server = this;
    const as = <T>(fn: () => T): T => {
      this.#origin = client.id;
      try {
        return fn();
      } finally {
        this.#origin = null;
      }
    };
    const agent = (sid: string) => {
      const h = client.agents.get(sid);
      if (!h) throw new Error(`not attached to agent session ${sid}`);
      return h;
    };
    const shell = (id: string) => {
      const h = client.shells.get(id);
      if (!h) throw new Error(`no such shell: ${id}`);
      return h;
    };
    const adoptAgent = (h: AgentHandle) => {
      client.agents.get(h.sid)?.detach();
      client.agents.set(h.sid, h);
      // Streaming deltas arrive token by token; coalesce them so a slow device
      // handles ~30 messages a second instead of hundreds.
      let held: { type: 'text' | 'thinking'; delta: string } | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        clearTimeout(timer);
        timer = undefined;
        if (held) peer.emit('agent', { sid: h.sid, event: held });
        held = null;
      };
      h.onEvent((event) => {
        if (event.type === 'text' || event.type === 'thinking') {
          if (held && held.type !== event.type) flush();
          if (held) held.delta += event.delta;
          else held = { type: event.type, delta: event.delta };
          timer ??= setTimeout(flush, 33);
          return;
        }
        flush();
        peer.emit('agent', { sid: h.sid, event });
      });
      h.onAsk((question, options) => this.#ask<string>({ kind: 'user', sid: h.sid, payload: { question, options } }, undefined, client));
      h.prompter = (req: PermRequest, signal) => this.#ask<PermDecision>({ kind: 'perm', sid: h.sid, payload: req }, signal).catch(() => 'deny');
      return { sid: h.sid, pid: h.pid };
    };

    peer.handle({
      async hello(role: 'ui' | 'host'): Promise<Hello> {
        client.role = role;
        await fs.ready;
        return {
          clientId: client.id,
          pidBase: client.id * PID_BLOCK,
          version: os.version,
          rootKind: os.rootKind,
          shared: server.shared,
          settings: os.settings.entries(),
          procs: os.procs.list().map(wire),
          mounts: fs.mounts().map((m) => ({ point: m.point, label: m.fs.label, readonly: m.fs.readonly ?? false })),
          bootMarks: os.bootMarks,
          log: os.kernelLog,
        };
      },

      // Filesystem
      'fs.readFile': (p: string) => fs.readFile(p),
      'fs.writeFile': (p: string, d: string | Uint8Array) => fs.writeFile(p, d),
      'fs.appendFile': (p: string, d: string | Uint8Array) => fs.appendFile(p, d),
      'fs.readdir': (p: string) => fs.readdir(p),
      'fs.stat': (p: string) => fs.stat(p),
      'fs.mkdir': (p: string) => fs.mkdir(p),
      'fs.rm': (p: string, o?: { recursive?: boolean }) => fs.rm(p, o),
      'fs.cp': (a: string, b: string) => fs.cp(a, b),
      'fs.mv': (a: string, b: string) => fs.mv(a, b),
      'fs.glob': (pattern: string, cwd?: string, limit?: number) => fs.glob(pattern, cwd, limit),
      'fs.unmount': (point: string) => fs.unmount(point),
      'fs.mounts': () => fs.mounts().map((m) => ({ point: m.point, label: m.fs.label, readonly: m.fs.readonly ?? false })),
      'fs.mountHandle': (handle: FileSystemDirectoryHandle) => os.mountHandle(handle),

      // Dev servers
      'dev.start': (o: DevStartOptions) => os.dev.start(o),
      'dev.stop': (port: number) => os.dev.stop(port),
      'dev.list': () => os.dev.list(),
      'dev.page': (port: number, path?: string) => os.dev.page(port, path),
      'dev.request': (port: number, req: WireRequest) => os.dev.request(port, req),
      'dev.log': (port: number, entries: Parameters<KernelCore['dev']['log']>[1]) => os.dev.log(port, entries),
      'dev.logs': (port: number, o?: { after?: number; limit?: number }) => os.dev.logs(port, o),

      // Settings & secrets (write-only from windows)
      'settings.set': (key: string, value: unknown) => as(() => os.settings.set(key, value)),
      'secrets.has': (name: string) => os.secrets.has(name),
      'secrets.set': (name: string, value: string) => os.secrets.set(name, value),
      'secrets.delete': (name: string) => os.secrets.delete(name),

      // Processes. A window's own processes (apps, sandboxes) are registered here so they show up everywhere.
      'procs.spawn': (p: WireProc) => {
        if (Math.floor(p.pid / PID_BLOCK) !== client.id) throw new Error('pid outside this client’s range');
        os.procs.spawn({ pid: p.pid, name: p.name, kind: p.kind, ppid: p.ppid, detail: p.detail, onKill: () => peer.emit('proc:kill', p.pid) });
      },
      'procs.update': (pid: number, patch: Partial<Pick<Proc, 'state' | 'detail' | 'memBytes'>>) => os.procs.update(pid, patch),
      'procs.account': (pid: number, ms: number) => os.procs.account(pid, ms),
      'procs.kill': (pid: number, reason?: string) => os.procs.kill(pid, reason),

      // Events a window may raise
      'bus.emit': (type: 'notify' | 'app:open', payload: never) => {
        if (type !== 'notify' && type !== 'app:open') throw new Error(`windows may not emit ${String(type)}`);
        // Mark app requests from windows, so the agent window only follows the kernel's own (the agent's tools, the shell).
        // Apps a GUI window opens for itself are its own business; the hidden bridge (a Node.js dev server starting) speaks for the kernel.
        as(() => os.bus.emit(type, type === 'app:open' ? ({ ...(payload as object), fromWindow: client.role === 'ui' } as never) : payload));
      },

      // Agents
      'agent.create': async (opts?: { resume?: string; ppid?: number; private?: boolean }) => adoptAgent(await os.agents.create(opts)),
      'agent.attach': async (sid: string) => adoptAgent(await os.agents.attach(sid)),
      'agent.live': () => os.agents.live(),
      'agent.probeModels': (baseUrl: string, kind?: 'local' | 'openai') => os.agents.probeModels(baseUrl, kind),
      'agent.send': (sid: string, text: string, opts?: { plan?: boolean }) => agent(sid).send(text, opts),
      'agent.rewind': (sid: string, index: number, files: boolean) => agent(sid).rewind(index, files),
      'agent.changes': (sid: string) => agent(sid).changes(),
      'agent.stop': (sid: string) => agent(sid).stop(),
      'agent.snapshot': (sid: string) => agent(sid).snapshot(),
      'agent.context': (sid: string) => agent(sid).context(),
      'agent.compact': (sid: string) => agent(sid).compact(),
      'agent.probeMcp': (name: string) => os.agents.probeMcp(name),
      'agent.detach': (sid: string) => {
        client.agents.get(sid)?.detach();
        client.agents.delete(sid);
      },
      'agent.dispose': (sid: string) => {
        client.agents.get(sid)?.dispose();
        client.agents.delete(sid);
      },

      // Shells
      'shell.open': async (opts?: { cwd?: string; ppid?: number }) => {
        const h = await os.shells.open(opts);
        client.shells.set(h.id, h);
        h.onReadLine((prompt, secret) => this.#ask<string | null>({ kind: 'tty', shellId: h.id, payload: { prompt, secret } }, undefined, client));
        h.onClear(() => peer.emit('shell:clear', h.id));
        return { id: h.id, cwd: h.cwd, home: h.home };
      },
      'shell.run': async (id: string, runId: number, line: string) => {
        const h = shell(id);
        const ctl = new AbortController();
        const off = peer.on<number>('shell:abort', (r) => r === runId && ctl.abort());
        try {
          const code = await h.run(line, { out: (t) => peer.emit('shell:out', { runId, s: 'o', t }), err: (t) => peer.emit('shell:out', { runId, s: 'e', t }), signal: ctl.signal });
          // Cancel anything the command was still waiting on (e.g. a readLine).
          for (const a of [...this.#asks.values()]) if (a.ask.shellId === id) a.resolve(null);
          return { code, cwd: h.cwd };
        } finally {
          off();
        }
      },
      'shell.complete': (id: string, line: string) => shell(id).complete(line),
      'shell.close': (id: string) => {
        client.shells.get(id)?.close();
        client.shells.delete(id);
      },

      // Answers to kernel questions
      answer: (askId: number, value: unknown) => {
        const a = this.#asks.get(askId);
        if (a?.targets.has(client.id)) a.resolve(value);
      },
    });

    // Sandbox output streamed back from a host bridge.
    peer.on<{ runId: number; s: 'o' | 'e'; t: string }>('host:out', ({ runId, s, t }) => {
      const run = this.#runs.get(runId);
      (s === 'o' ? run?.onStdout : run?.onStderr)?.(t);
    });
    peer.on<{ runId: number; label: string; loaded: number; total: number }>('host:progress', ({ runId, ...p }) => this.#runs.get(runId)?.onProgress?.(p));
    // A window announces which Web Lock it holds; when we can take it, the window is gone.
    peer.on<string>('alive', (lockName) => {
      void navigator.locks?.request(lockName, () => this.#drop(client));
    });
    peer.on('bye', () => this.#drop(client));
    this.#clients.set(client.id, client);
  }

  #drop(client: Client): void {
    if (!this.#clients.delete(client.id)) return;
    client.peer.close();
    for (const h of client.agents.values()) h.detach(); // sessions keep running
    for (const h of client.shells.values()) h.close();
    for (const p of this.os.procs.list()) if (Math.floor(p.pid / PID_BLOCK) === client.id) this.os.procs.kill(p.pid, 'window closed');
    // Unanswerable questions: fail the ones that only this client could answer.
    for (const [askId, a] of this.#asks) {
      a.targets.delete(client.id);
      if (!a.targets.size) {
        this.#asks.delete(askId);
        a.resolve(a.ask.kind === 'perm' ? 'deny' : null);
      }
    }
  }
}
