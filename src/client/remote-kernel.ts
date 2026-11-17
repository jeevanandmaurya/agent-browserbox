import type { AgentEvent } from '@/agent/agent';
import type { AgentHandle, AgentsApi, FsApi, Kernel, MountInfo, ProcsApi, SecretsApi, ShellHandle, ShellIo, ShellsApi } from '@/kernel/api';
import { Bus } from '@/kernel/bus';
import { detectCaps, type PlatformCap } from '@/kernel/caps';
import { KCore } from '@/kernel/kcore';
import type { PacksApi } from '@/kernel/packs';
import { Permissions, type PermRequest, type Prompter } from '@/kernel/perms';
import type { Proc, SpawnOptions } from '@/kernel/proc';
import { Settings } from '@/kernel/settings';
import type { KernelEvents, Notice } from '@/kernel/types';
import { normalize } from '@/kernel/vfs/path';
import type { Stat } from '@/kernel/vfs/types';
import type { Ask, Hello, WireProc } from '@/kernel-worker/server';
import { Peer, type Handlers } from '@/rpc/peer';
import type { KernelLink } from './connect';

const NEVER = new AbortController().signal;
const dec = new TextDecoder();

interface AgentLocal {
  events: Set<(e: AgentEvent) => void>;
  asker?: (q: string, o?: string[]) => Promise<string>;
  prompter?: Prompter;
}

interface Owned {
  proc: Proc;
  ctl: AbortController;
  onKill?: () => void;
}

/**
 * A window's handle on the kernel. Read-mostly state (settings, the process
 * table, mounts) is mirrored locally so UI code can read it synchronously;
 * everything else is an RPC to the kernel worker. It implements the same
 * `Kernel` interface as the real kernel, so apps cannot tell the difference.
 */
export class RemoteKernel implements Kernel {
  version = '';
  rootKind: 'opfs' | 'memory' = 'opfs';
  /** False when this window had to start a private kernel. */
  shared = true;
  readonly bootStart = 0;
  readonly bootMarks: Array<{ name: string; at: number }> = [];
  readonly bus = new Bus<KernelEvents>();
  readonly settings = new Settings(this.bus, (key, value) => void this.call('settings.set', key, value));
  readonly perms = new Permissions(this.settings);
  /** Not loaded here: windows use its JS fallbacks; the WASM core runs in the kernel. */
  readonly kcore = new KCore();
  readonly caps: PlatformCap[] = detectCaps();
  readonly ready: Promise<void>;

  #peer: Promise<Peer>;
  #procs = new Map<number, Proc>();
  #owned = new Map<number, Owned>();
  #nextPid = 0;
  #mounts: MountInfo[] = [];
  #agents = new Map<string, AgentLocal>();
  #shells = new Map<string, { reader?: (prompt: string) => Promise<string | null>; clear?: () => void }>();
  #runs = new Map<number, ShellIo>();
  #nextRun = 1;
  #asking = new Map<number, AbortController>();

  constructor(link: Promise<KernelLink>, role: 'ui' | 'host' = 'ui') {
    this.#peer = link.then(({ port, lock, shared }) => {
      this.shared = shared;
      const peer = new Peer(port);
      this.#wire(peer);
      peer.emit('alive', lock);
      return peer;
    });
    this.ready = this.#peer.then(async (peer) => this.#hydrate(await peer.call<Hello>('hello', role)));
  }

  /** Calls a kernel method once connected. */
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return (await this.#peer).call<T>(method, ...args);
  }

  /** Lets the kernel call into this window (used by the sandbox host). */
  async handle(handlers: Handlers): Promise<Peer> {
    return (await this.#peer).handle(handlers);
  }

  #hydrate(hello: Hello): void {
    this.version = hello.version;
    this.rootKind = hello.rootKind;
    this.#nextPid = hello.pidBase + 1;
    this.#mounts = hello.mounts.map((m) => ({ point: m.point, fs: { label: m.label, readonly: m.readonly } }));
    this.bootMarks.push(...hello.bootMarks.map((m) => ({ name: `kernel:${m.name}`, at: m.at })));
    this.settings.hydrate(hello.settings);
    for (const p of hello.procs) this.bus.emit('proc:spawn', this.#mirror(p));
    this.mark('kernel-connected');
  }

  #mirror(w: WireProc): Proc {
    const existing = this.#procs.get(w.pid);
    if (existing) return Object.assign(existing, w);
    const proc: Proc = { ...w, signal: NEVER };
    this.#procs.set(w.pid, proc);
    return proc;
  }

  #wire(peer: Peer): void {
    peer.on<{ type: keyof KernelEvents; payload: never }>('bus', ({ type, payload }) => {
      if (type === 'settings:change') {
        const { key, value } = payload as KernelEvents['settings:change'];
        this.settings.applyRemote(key, value);
      } else if (type === 'proc:spawn' || type === 'proc:update') {
        this.bus.emit(type, this.#mirror(payload as WireProc));
      } else if (type === 'proc:exit') {
        const { proc, reason } = payload as { proc: WireProc; reason: string };
        const local = this.#mirror(proc);
        this.#procs.delete(proc.pid);
        this.#reap(proc.pid, reason);
        this.bus.emit('proc:exit', { proc: local, reason });
      } else if (type === 'fs:change' && (payload as KernelEvents['fs:change']).type === 'mount') {
        void peer.call<Hello['mounts']>('fs.mounts').then((list) => {
          this.#mounts = list.map((m) => ({ point: m.point, fs: { label: m.label, readonly: m.readonly } }));
          this.bus.emit(type, payload);
        });
      } else this.bus.emit(type, payload);
    });
    peer.on<number>('proc:kill', (pid) => this.#reap(pid, 'killed'));
    peer.on<{ sid: string; event: AgentEvent }>('agent', ({ sid, event }) => {
      for (const fn of [...(this.#agents.get(sid)?.events ?? [])]) fn(event);
    });
    peer.on<{ runId: number; s: 'o' | 'e'; t: string }>('shell:out', ({ runId, s, t }) => {
      const io = this.#runs.get(runId);
      (s === 'o' ? io?.out : io?.err)?.(t);
    });
    peer.on<string>('shell:clear', (id) => this.#shells.get(id)?.clear?.());
    peer.on<Ask>('ask', (ask) => void this.#answer(peer, ask));
    peer.on<number>('ask:done', (askId) => {
      this.#asking.get(askId)?.abort();
      this.#asking.delete(askId);
    });
  }

  /** The kernel needs something only a window can provide: a decision, an answer, a line of input. */
  async #answer(peer: Peer, ask: Ask): Promise<void> {
    const ctl = new AbortController();
    this.#asking.set(ask.askId, ctl);
    let value: unknown;
    try {
      if (ask.kind === 'perm') {
        const custom = ask.sid ? this.#agents.get(ask.sid)?.prompter : undefined;
        value = await (custom ? custom(ask.payload as PermRequest, ctl.signal) : this.perms.prompt(ask.payload as PermRequest, ctl.signal));
      } else if (ask.kind === 'user') {
        const asker = ask.sid ? this.#agents.get(ask.sid)?.asker : undefined;
        if (!asker) return; // another window owns this conversation
        const { question, options } = ask.payload as { question: string; options?: string[] };
        value = await asker(question, options);
      } else if (ask.kind === 'tty') {
        const reader = ask.shellId ? this.#shells.get(ask.shellId)?.reader : undefined;
        value = reader ? await reader(String(ask.payload)) : null;
      } else {
        const { method, args } = ask.payload as { method: string; args: unknown[] };
        if (method === 'clipboard.write') value = await navigator.clipboard.writeText(String(args[0]));
        else if (method === 'clipboard.read') value = await navigator.clipboard.readText();
        else if (method === 'speak') speechSynthesis.speak(new SpeechSynthesisUtterance(String(args[0])));
      }
    } catch (err) {
      if (ctl.signal.aborted) return;
      value = ask.kind === 'perm' ? 'deny' : ask.kind === 'ui' ? `failed: ${(err as Error).message}` : null;
    }
    if (ctl.signal.aborted) return;
    this.#asking.delete(ask.askId);
    void peer.call('answer', ask.askId, value);
  }

  /** Local cleanup for one of this window's own processes. */
  #reap(pid: number, reason: string): void {
    const o = this.#owned.get(pid);
    if (!o) return;
    this.#owned.delete(pid);
    o.ctl.abort(new DOMException(reason, 'AbortError'));
    try {
      o.onKill?.();
    } catch (err) {
      console.error('[procs] onKill threw', err);
    }
  }

  readonly procs: ProcsApi = {
    spawn: (opts: SpawnOptions): Proc => {
      if (!this.#nextPid) throw new Error('kernel not connected yet');
      const ctl = new AbortController();
      const proc: Proc = { pid: this.#nextPid++, ppid: opts.ppid ?? 0, name: opts.name, kind: opts.kind, started: Date.now(), state: 'running', detail: opts.detail ?? '', cpuMs: 0, memBytes: 0, signal: ctl.signal };
      this.#procs.set(proc.pid, proc);
      this.#owned.set(proc.pid, { proc, ctl, onKill: opts.onKill });
      const { signal: _signal, ...wire } = proc;
      void this.call('procs.spawn', wire);
      return proc;
    },
    update: (pid, patch) => {
      const p = this.#procs.get(pid);
      if (p) Object.assign(p, patch);
      void this.call('procs.update', pid, patch);
    },
    account: (pid, ms) => {
      const p = this.#procs.get(pid);
      if (p) p.cpuMs += ms;
      void this.call('procs.account', pid, ms);
    },
    kill: (pid, reason = 'killed') => {
      if (!this.#procs.has(pid)) return false;
      if (this.#owned.has(pid)) this.#procs.delete(pid);
      this.#reap(pid, reason);
      void this.call('procs.kill', pid, reason);
      return true;
    },
    exit: (pid) => void this.procs.kill(pid, 'exit'),
    get: (pid) => this.#procs.get(pid),
    list: () => [...this.#procs.values()].sort((a, b) => a.started - b.started || a.pid - b.pid),
  };

  readonly fs: FsApi = ((self: RemoteKernel): FsApi => ({
    get ready() {
      return self.ready;
    },
    readFile: (p) => self.call('fs.readFile', p),
    readText: async (p) => dec.decode(await self.call<Uint8Array>('fs.readFile', p)),
    writeFile: (p, d) => self.call('fs.writeFile', p, d),
    appendFile: (p, d) => self.call('fs.appendFile', p, d),
    readdir: (p) => self.call('fs.readdir', p),
    stat: (p) => self.call('fs.stat', p),
    exists: (p) => self.call<Stat | null>('fs.stat', p).then(Boolean, () => false),
    mkdir: (p) => self.call('fs.mkdir', p),
    rm: (p, o) => self.call('fs.rm', p, o),
    cp: (a, b) => self.call('fs.cp', a, b),
    mv: (a, b) => self.call('fs.mv', a, b),
    glob: (pattern, cwd, limit) => self.call('fs.glob', pattern, cwd, limit),
    async *walk(root, opts = {}) {
      const stack: Array<[string, number]> = [[normalize(root), 0]];
      while (stack.length) {
        const [dir, depth] = stack.pop()!;
        opts.signal?.throwIfAborted();
        const entries = await self.call<Stat[]>('fs.readdir', dir).catch(() => []);
        for (const e of entries) {
          yield e;
          if (e.kind === 'dir' && depth + 1 < (opts.maxDepth ?? 32) && e.path !== '/proc') stack.push([e.path, depth + 1]);
        }
      }
    },
    mounts: () => self.#mounts,
    unmount: (point) => void self.call('fs.unmount', point),
  }))(this);

  readonly secrets: SecretsApi = {
    has: (name) => this.call('secrets.has', name),
    set: (name, value) => this.call('secrets.set', name, value),
    delete: (name) => this.call('secrets.delete', name),
  };

  readonly packs: PacksApi = {
    list: () => this.call('packs.list'),
    install: (id) => this.call('packs.install', id),
    remove: (id) => this.call('packs.remove', id),
  };

  readonly agents: AgentsApi = {
    create: async (opts) => this.#agentHandle(await this.call<{ sid: string; pid: number }>('agent.create', opts)),
    attach: async (sid) => this.#agentHandle(await this.call<{ sid: string; pid: number }>('agent.attach', sid)),
    live: () => this.call('agent.live'),
    probeModels: (baseUrl) => this.call('agent.probeModels', baseUrl),
    probeMcp: (name) => this.call('agent.probeMcp', name),
  };

  #agentHandle({ sid, pid }: { sid: string; pid: number }): AgentHandle {
    const local: AgentLocal = { events: new Set() };
    this.#agents.set(sid, local);
    const forget = () => {
      if (this.#agents.get(sid) === local) this.#agents.delete(sid);
    };
    return {
      sid,
      pid,
      send: (text) => this.call('agent.send', sid, text),
      stop: () => void this.call('agent.stop', sid),
      snapshot: () => this.call('agent.snapshot', sid),
      context: () => this.call('agent.context', sid),
      compact: () => this.call('agent.compact', sid),
      onEvent: (fn) => {
        local.events.add(fn);
        return () => local.events.delete(fn);
      },
      onAsk: (fn) => {
        local.asker = fn;
      },
      get prompter() {
        return local.prompter;
      },
      set prompter(p) {
        local.prompter = p;
      },
      detach: () => {
        forget();
        void this.call('agent.detach', sid);
      },
      dispose: () => {
        forget();
        void this.call('agent.dispose', sid);
      },
    };
  }

  readonly shells: ShellsApi = {
    open: async (opts) => {
      const info = await this.call<{ id: string; cwd: string; home: string }>('shell.open', opts);
      const local: { reader?: (prompt: string) => Promise<string | null>; clear?: () => void } = {};
      this.#shells.set(info.id, local);
      const handle: ShellHandle = {
        id: info.id,
        cwd: info.cwd,
        home: info.home,
        run: async (line, io) => {
          const runId = this.#nextRun++;
          this.#runs.set(runId, io);
          const abort = () => void this.#peer.then((p) => p.emit('shell:abort', runId));
          io.signal?.addEventListener('abort', abort);
          try {
            const r = await this.call<{ code: number; cwd: string }>('shell.run', info.id, runId, line);
            handle.cwd = r.cwd;
            return r.code;
          } finally {
            io.signal?.removeEventListener('abort', abort);
            this.#runs.delete(runId);
          }
        },
        complete: (line) => this.call('shell.complete', info.id, line),
        onReadLine: (fn) => {
          local.reader = fn;
        },
        onClear: (fn) => {
          local.clear = fn;
        },
        close: () => {
          this.#shells.delete(info.id);
          void this.call('shell.close', info.id);
        },
      };
      return handle;
    },
  };

  mark(name: string): void {
    this.bootMarks.push({ name, at: Math.round(performance.now() * 10) / 10 });
  }

  hasCap(id: string): boolean {
    return this.caps.find((c) => c.id === id)?.ok ?? false;
  }

  notify(notice: Notice | string): void {
    const payload = typeof notice === 'string' ? { title: notice } : notice;
    this.bus.emit('notify', payload);
    void this.call('bus.emit', 'notify', payload);
  }

  openApp(id: string, args?: Record<string, unknown>): void {
    this.bus.emit('app:open', { id, args });
    void this.call('bus.emit', 'app:open', { id, args });
  }

  /** Shows the folder picker here (it needs a window) and hands the folder to the kernel. */
  async mountNativeFolder(): Promise<string> {
    const picker = (globalThis as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) throw new Error('This browser does not support mounting local folders (File System Access API).');
    return this.call('fs.mountHandle', await picker({ mode: 'readwrite' }));
  }
}

