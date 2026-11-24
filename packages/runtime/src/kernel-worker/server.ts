import type { ContributedCommand, ShellHandle } from '../kernel/api';
import type { KernelCore } from '../kernel/kernel';
import type { Secrets } from '../kernel/secrets';
import { validatePackage } from '../kernel/packages';
import type { PermDecision, PermRequest } from '../kernel/perms';
import type { Proc } from '../kernel/proc';
import type { KernelEvents, KernelLogLine } from '../kernel/types';
import { Peer, type Handlers } from '../rpc/peer';
import type { DevStartOptions, WireRequest } from '../kernel/dev/types';
import { setSandboxHost, type BackendOp, type BackendPayload, type RunOptions, type RunResult } from '../sandbox/sandbox';

export { PID_BLOCK, type Ask, type AskKind, type Hello, type WireProc } from './wire';
import { PID_BLOCK, type Ask, type Hello, type WireProc } from './wire';

interface Client {
  id: number;
  peer: Peer;
  /** 'new' until the client says hello. Only 'ui' clients are windows a person can see. */
  /**
   * 'new' until the client says hello. 'ui': a window a person sees (asked general questions,
   * clipboard, …). 'sdk': an SDK connection (gets events; asked only about its own shells).
   * 'host': a bridge hosting sandboxes.
   */
  role: 'ui' | 'sdk' | 'host' | 'new';
  shells: Map<string, ShellHandle>;
  /** Cleanups from services, run when the client goes. */
  drops: Array<() => void>;
}

/** A connected client, as a service sees it. */
export interface ClientScope {
  readonly id: number;
  readonly peer: Peer;
  /** Asks windows something (a permission, a question) and waits for the first answer. `onlyThisClient` asks just this one. */
  ask<T>(ask: Omit<Ask, 'askId'>, signal?: AbortSignal, onlyThisClient?: boolean): Promise<T>;
}

/**
 * A service built on the kernel (agents, …) that windows reach over RPC. The
 * server stays ignorant of it: for each client it asks the service for its
 * RPC methods and for what to clean up when the client goes.
 */
export interface ServerService {
  connect(client: ClientScope): { handlers: Handlers; drop?: () => void };
}

const wire = (p: Proc): WireProc => ({ pid: p.pid, ppid: p.ppid, name: p.name, kind: p.kind, started: p.started, state: p.state, detail: p.detail, cpuMs: p.cpuMs, memBytes: p.memBytes });
const FORWARDED: Array<keyof KernelEvents> = ['fs:change', 'settings:change', 'secrets:lock', 'notify', 'app:open', 'kmsg', 'dev:update', 'dev:log'];

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
  /** Contributed commands running in a client: their I/O, by run id. */
  #cmdRuns = new Map<number, Parameters<ContributedCommand['run']>[0]>();
  #nextCmd = 1;
  /** Suppresses echoing an event back to the client that caused it. */
  #origin: number | null = null;
  #services: ServerService[] = [];

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
    setSandboxHost({ run: (kind, payload, opts) => this.#hostRun(kind, payload, opts), backend: (op, id, payload, opts) => this.#hostBackend(op, id, payload, opts) });
  }

  /** Adds a service's RPC methods for clients that connect from now on. */
  use(service: ServerService): this {
    this.#services.push(service);
    return this;
  }

  #broadcast(name: string, payload: unknown, except: number | null = null): void {
    for (const c of this.#clients.values()) if (c.id !== except && (c.role === 'ui' || c.role === 'sdk')) c.peer.emit(name, payload);
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
    const client: Client = { id: this.#nextClient++, peer, role: 'new', shells: new Map(), drops: [] };
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
    const shell = (id: string) => {
      const h = client.shells.get(id);
      if (!h) throw new Error(`no such shell: ${id}`);
      return h;
    };
    peer.handle({
      async hello(role: 'ui' | 'sdk' | 'host'): Promise<Hello> {
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
      // Password lock. Every window of the profile hears about a change ('secrets:lock').
      'secrets.status': () => os.secrets.status(),
      'secrets.unlock': async (password: string) => {
        const ok = await os.secrets.unlock(password);
        if (ok) os.bus.emit('secrets:lock', { state: await os.secrets.status() });
        return ok;
      },
      'secrets.lock': async () => {
        await os.secrets.lock();
        os.bus.emit('secrets:lock', { state: await os.secrets.status() });
      },
      'secrets.setPassword': async (password: string | null) => {
        await os.secrets.setPassword(password);
        os.bus.emit('secrets:lock', { state: await os.secrets.status() });
      },
      'secrets.passkeys': () => os.secrets.passkeys(),
      'secrets.addPasskey': (password: string, p: Parameters<Secrets['addPasskey']>[1]) => os.secrets.addPasskey(password, p),
      'secrets.unlockWithPasskey': async (id: string, prf: Uint8Array<ArrayBuffer>) => {
        const ok = await os.secrets.unlockWithPasskey(id, prf);
        if (ok) os.bus.emit('secrets:lock', { state: await os.secrets.status() });
        return ok;
      },
      'secrets.removePasskey': (id: string) => os.secrets.removePasskey(id),

      // Packages: only a person's window manages them (Settings → Packages); the agent uses `pkg`, which keeps its own limits.
      ...packageHandlers(os, () => {
        if (client.role !== 'ui') throw new Error('only a BrowserBox window can manage packages');
      }),

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
        // Apps a GUI window opens for itself are its own business; the hidden bridge speaks for the kernel.
        as(() => os.bus.emit(type, type === 'app:open' ? ({ ...(payload as object), fromWindow: client.role === 'ui' } as never) : payload));
      },

      // Shells
      'shell.open': async (opts?: { cwd?: string; ppid?: number; confined?: boolean }) => {
        // A confined shell's permission questions go to the window that opened it, not to every window.
        const prompter = opts?.confined ? (req: PermRequest, signal?: AbortSignal) => this.#ask<PermDecision>({ kind: 'perm', payload: req }, signal, client).catch(() => 'deny' as const) : undefined;
        const h = await os.shells.open({ ...opts, prompter });
        client.shells.set(h.id, h);
        // Prompts reach the client only once it shows the shell in a terminal ('shell.attach'):
        // until then nobody is there to answer, and commands for people only (profile changes) refuse.
        h.onClear(() => peer.emit('shell:clear', h.id));
        h.onAction?.((a) => peer.emit('shell:action', { id: h.id, a }));
        return { id: h.id, cwd: h.cwd, home: h.home };
      },
      'shell.attach': (id: string) => {
        shell(id).onReadLine((prompt, secret) => this.#ask<string | null>({ kind: 'tty', shellId: id, payload: { prompt, secret } }, undefined, client));
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
      // Commands this client runs for every shell (the app's agent offers agent, setup, gh, deploy).
      'shell.contribute': (defs: Array<{ name: string; summary: string; usage?: string }>) => {
        for (const d of defs) {
          const off = os.shells.contribute?.({
            name: d.name,
            summary: d.summary,
            usage: d.usage,
            run: async (io) => {
              const runId = this.#nextCmd++;
              this.#cmdRuns.set(runId, io);
              const abort = () => peer.emit('cmd:abort', runId);
              io.signal.addEventListener('abort', abort);
              try {
                return await peer.call<number>('cmd.run', runId, d.name, { args: io.args, stdin: io.stdin, cwd: io.cwd, tty: !!io.readLine });
              } finally {
                io.signal.removeEventListener('abort', abort);
                this.#cmdRuns.delete(runId);
              }
            },
          });
          if (off) client.drops.push(off);
        }
      },
      'cmd.readLine': (runId: number, prompt: string, secret: boolean) => this.#cmdRuns.get(runId)?.readLine?.(prompt, secret) ?? null,

      // Answers to kernel questions
      answer: (askId: number, value: unknown) => {
        const a = this.#asks.get(askId);
        if (a?.targets.has(client.id)) a.resolve(value);
      },
    });

    const scope: ClientScope = {
      id: client.id,
      peer,
      ask: (ask, signal, onlyThisClient) => this.#ask(ask, signal, onlyThisClient ? client : undefined),
    };
    for (const service of this.#services) {
      const { handlers, drop } = service.connect(scope);
      peer.handle(handlers);
      if (drop) client.drops.push(drop);
    }

    // Output of contributed commands running in this client.
    peer.on<{ runId: number; s: 'o' | 'e'; t: string }>('cmd:out', ({ runId, s, t }) => {
      const io = this.#cmdRuns.get(runId);
      (s === 'o' ? io?.out : io?.err)?.(t);
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
    for (const drop of client.drops) drop();
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

/** The package manager over RPC, for windows (each call checks the caller with `only`). */
function packageHandlers(os: KernelCore, only: () => void): Handlers {
  const p = os.packages;
  const fetchPackage = async (url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('not a link to a package');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not fetch ${url} (HTTP ${res.status})`);
    return validatePackage(await res.json());
  };
  const g = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => (only(), fn(...a));
  return {
    'pkg.builtin': g(() => p.list()),
    'pkg.index': g(async (refresh?: boolean) => {
      const have = p.externals();
      return (await p.index(!!refresh)).map((x) => ({ ...x, installedVersion: have[x.id]?.pkg.version }));
    }),
    'pkg.installed': g(() => Object.values(p.externals())),
    'pkg.install': g(async (id: string) => {
      if (p.manifests().some((m) => m.id === id)) {
        await p.install(id);
        return [id];
      }
      const [name, version] = id.split('@') as [string, string | undefined];
      const found = await p.find(name, { version });
      if (!found) throw new Error(`no such package: ${id}`);
      return p.installExternal(found, found.source);
    }),
    'pkg.describeUrl': g((url: string) => fetchPackage(url)),
    'pkg.installFrom': g(async (url: string) => p.installExternal(await fetchPackage(url), url)),
    'pkg.remove': g((id: string, o?: { force?: boolean }) => (p.externals()[id] ? p.removeExternal(id, o) : p.remove(id, o))),
    'pkg.dependents': g((id: string) => p.dependents(id)),
    'pkg.upgradable': g(() => p.upgradable()),
    'pkg.verify': g(() => p.verify()),
    'pkg.sources': g(() => p.sources()),
    'pkg.addSource': g((url: string) => p.addSource(url)),
    'pkg.removeSource': g((url: string) => p.removeSource(url)),
  };
}

