import { connectKernel, type KernelLink } from '../src/client/connect';
import { RemoteKernel } from '../src/client/remote-kernel';
import { EMBED_ORIGINS } from '../src/config/origins';
import type { PermDecision, PermRequest } from '../src/kernel/perms';
import { APP_KERNEL, fromSearch, type KernelInstance } from '../src/kernel/instance';
import { HOME } from '../src/kernel/paths';
import { plainText, stripAnsi } from '../src/shell/ansi';
import type { ShellHandle } from '../src/kernel/api';
import { PROTOCOL_VERSION, type DevServer, type ExecOptions, type ExecResult, type FromRuntime, type Hello, type KernelChannel, type Methods, type ToRuntime } from '../../sdk/src/protocol';

/**
 * The SDK runtime: a UI-less page that owns a BrowserBox kernel and lends it
 * to the page embedding it, over a MessagePort handed over in the handshake
 * (see packages/sdk/src/protocol.ts).
 *
 * Only this page needs the kernel, the worker and the wasm. The embedding page
 * loads the SDK client alone and needs no special headers.
 */
// Which kernel this page drives comes from its URL, set by the SDK:
//   embed/?box=<id>&storage=opfs|memory  a box of its own (default: the 'default' box)
//   embed/?site=1                        the site's own kernel (the BrowserBox app's), whose files,
//                                        settings and keys stay where they are. Browsers partition
//                                        a cross-site frame's storage, so only the site itself reaches its data.
const query = new URLSearchParams(location.search);
const fromUrl = fromSearch(location.search);
const instance: KernelInstance = query.get('site') === '1' ? APP_KERNEL : { box: fromUrl.box ?? 'default', storage: fromUrl.box === null ? 'opfs' : fromUrl.storage };
const firstLink = connectKernel({ instance });
/** A port to the kernel for one more client (each SDK connection has its own). */
const moreLinks = (): Promise<KernelLink> => firstLink.then((l) => l.more!());
const boxId = instance.box ?? 'site';

const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
type Io = { out(t: string): void; err(t: string): void };
type Impl = { [M in keyof Methods]: (...args: Parameters<Methods[M]>) => ReturnType<Methods[M]> | Promise<ReturnType<Methods[M]>> };
const devInfo = ({ port, root, url, backend, network }: DevServer): DevServer => ({ port, root, url, backend, network });

/**
 * One SDK connection: the embedding page's, or one it shared (box.share()).
 * Each has its own kernel client, so the kernel's permission questions for its
 * shells come back here, and its own shells and processes.
 */
class Connection {
  readonly os: RemoteKernel;
  #port: MessagePort;
  #nextAsk = 1;
  #asks = new Map<number, (d: PermDecision) => void>();
  #nextPid = 1;
  #running = new Map<number, AbortController>();
  #sessions = new Map<number, { shell: ShellHandle; busy: boolean }>();
  #nextSession = 1;

  constructor(port: MessagePort, link: Promise<KernelLink>) {
    this.#port = port;
    this.os = new RemoteKernel(link, 'sdk');
    // Permission questions for this connection's shells: asked of the page (or worker) on the other end.
    this.os.perms.setPrompter(
      (req: PermRequest, signal?: AbortSignal) =>
        new Promise<PermDecision>((resolve) => {
          const id = this.#nextAsk++;
          this.#asks.set(id, resolve);
          signal?.addEventListener('abort', () => this.#asks.delete(id) && resolve('deny'));
          this.send({ t: 'permission', id, request: { cap: req.cap, actor: req.actor, title: req.title, detail: req.detail } });
        }),
    );
    port.onmessage = (m: MessageEvent<ToRuntime>) => void this.#onMessage(m.data);
  }

  send(msg: FromRuntime, transfer: Transferable[] = []): void {
    this.#port.postMessage(msg, transfer);
  }

  async hello(): Promise<Hello> {
    await this.os.ready;
    await this.os.fs.ready;
    return { t: 'hello', protocol: PROTOCOL_VERSION, version: this.os.version, id: boxId, home: HOME, caps: this.os.caps.filter((c) => c.ok).map((c) => c.id), storage: this.os.rootKind };
  }

  /** Opens a confined shell (network needs the embedding page's permission) with extra variables. */
  async #openShell(opts: { cwd?: string; env?: Record<string, string> }, err: (t: string) => void): Promise<ShellHandle> {
    const shell = await this.os.shells.open({ cwd: opts.cwd, confined: true });
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        shell.close();
        throw new Error(`invalid environment variable name: ${k}`);
      }
      await shell.run(`export ${k}=${quote(String(v))}`, { out: () => undefined, err });
    }
    return shell;
  }

  /** Runs a command line in `shell`. Output goes to `io` as it comes; 124 = timed out, 130 = killed. */
  async #runIn(shell: ShellHandle, command: string, timeoutMs: number | undefined, io: Io, ctl: AbortController): Promise<number> {
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), ctl.abort()), timeoutMs) : undefined;
    try {
      const code = await shell.run(command, { ...io, signal: ctl.signal });
      return timedOut ? 124 : ctl.signal.aborted ? 130 : code;
    } catch (err) {
      if (timedOut) return 124;
      if (ctl.signal.aborted) return 130;
      io.err(`${(err as Error).message}\n`);
      return 1;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs one command line in a fresh shell. */
  async #run(command: string, opts: ExecOptions, io: Io, ctl: AbortController): Promise<number> {
    let shell: ShellHandle;
    try {
      shell = await this.#openShell(opts, io.err);
    } catch (err) {
      io.err(`${(err as Error).message}\n`);
      return 1;
    }
    try {
      return await this.#runIn(shell, command, opts.timeoutMs, io, ctl);
    } finally {
      shell.close();
    }
  }

  #streamTo(pid: number): Io {
    return {
      out: (data) => this.send({ t: 'output', pid, stream: 'stdout', data: stripAnsi(data) }),
      err: (data) => this.send({ t: 'output', pid, stream: 'stderr', data: stripAnsi(data) }),
    };
  }

  #methods: Impl = {
    info: () => this.hello(),
    'fs.readFile': (path) => this.os.fs.readFile(path),
    'fs.readTextFile': (path) => this.os.fs.readText(path),
    'fs.writeFile': (path, data) => this.os.fs.writeFile(path, data),
    'fs.mkdir': (path) => this.os.fs.mkdir(path),
    'fs.readdir': async (path) => (await this.os.fs.readdir(path)).map(({ path, name, kind, size, mtime }) => ({ path, name, kind, size, mtime })),
    'fs.stat': async (path) => {
      const s = await this.os.fs.stat(path);
      return s && { path: s.path, name: s.name, kind: s.kind, size: s.size, mtime: s.mtime };
    },
    'fs.exists': (path) => this.os.fs.exists(path),
    'fs.rm': (path, opts) => this.os.fs.rm(path, opts),
    'fs.rename': (from, to) => this.os.fs.mv(from, to),
    'fs.cp': (from, to) => this.os.fs.cp(from, to),
    'fs.appendFile': (path, data) => this.os.fs.appendFile(path, data),
    'fs.glob': (pattern, cwd, limit) => this.os.fs.glob(pattern, cwd ?? HOME, limit),
    exec: async (command, opts = {}): Promise<ExecResult> => {
      let stdout = '';
      let stderr = '';
      const exitCode = await this.#run(command, opts, { out: (t) => (stdout += t), err: (t) => (stderr += t) }, new AbortController());
      // Programs read plain text: no colour codes, and progress bars redrawn with \r collapse to their final line.
      return { exitCode, stdout: plainText(stdout), stderr: plainText(stderr) };
    },
    spawn: (command, opts = {}) => {
      const pid = this.#nextPid++;
      const ctl = new AbortController();
      this.#running.set(pid, ctl);
      void this.#run(command, opts, this.#streamTo(pid), ctl).then((exitCode) => {
        this.#running.delete(pid);
        this.send({ t: 'exit', pid, exitCode });
      });
      return pid;
    },
    kill: (pid) => {
      const ctl = this.#running.get(pid);
      ctl?.abort();
      return !!ctl;
    },
    'shell.open': async (opts = {}) => {
      const shell = await this.#openShell(opts, () => undefined);
      const id = this.#nextSession++;
      this.#sessions.set(id, { shell, busy: false });
      return { id, cwd: shell.cwd };
    },
    'shell.run': (id, command, opts = {}) => {
      const s = this.#sessions.get(id);
      if (!s) throw new Error(`no such shell session: ${id}`);
      if (s.busy) throw new Error('this shell session is still running a command');
      s.busy = true;
      const pid = this.#nextPid++;
      const ctl = new AbortController();
      this.#running.set(pid, ctl);
      void this.#runIn(s.shell, command, opts.timeoutMs, this.#streamTo(pid), ctl).then((exitCode) => {
        s.busy = false;
        this.#running.delete(pid);
        this.send({ t: 'exit', pid, exitCode, cwd: s.shell.cwd });
      });
      return pid;
    },
    'shell.close': (id) => {
      this.#sessions.get(id)?.shell.close();
      this.#sessions.delete(id);
    },
    'dev.start': ({ root, port, network }) => this.os.dev.start({ root, port, network }).then(devInfo),
    'dev.stop': (port) => this.os.dev.stop(port),
    'dev.list': async () => (await this.os.dev.list()).map(devInfo),
    'dev.logs': async (port, opts) => (await this.os.dev.logs(port, opts)).map(({ seq, t, level, source, text }) => ({ seq, t, level, source, text })),
    'procs.list': () => this.os.procs.list().map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, kind: p.kind, state: p.state, detail: p.detail, started: p.started, cpuMs: p.cpuMs, memBytes: p.memBytes })),
    'procs.kill': (pid) => this.os.procs.kill(pid, 'killed through the SDK'),
    'kernel.connect': async (): Promise<KernelChannel> => {
      const link = await moreLinks();
      return { port: link.port, lock: link.lock, shared: link.shared };
    },
    share: () => {
      const { port1, port2 } = new MessageChannel();
      const conn = new Connection(port1, moreLinks());
      void conn.hello().then(
        (h) => conn.send(h),
        (err: Error) => conn.send({ t: 'refused', error: `the runtime failed to start: ${err.message}` }),
      );
      return port2;
    },
  };

  async #onMessage(msg: ToRuntime): Promise<void> {
    if (msg.t === 'permission-answer') {
      this.#asks.get(msg.id)?.(msg.decision);
      this.#asks.delete(msg.id);
      return;
    }
    if (msg.t !== 'call') return;
    const fn = Object.hasOwn(this.#methods, msg.method) ? (this.#methods[msg.method] as (...a: unknown[]) => unknown) : null;
    try {
      if (!fn) throw new Error(`unknown method: ${msg.method}`);
      const value = await fn(...(Array.isArray(msg.args) ? msg.args : []));
      // Bytes and ports travel by transfer.
      const transfer: Transferable[] = value instanceof Uint8Array ? [value.buffer] : value instanceof MessagePort ? [value] : value && typeof value === 'object' && (value as KernelChannel).port instanceof MessagePort ? [(value as KernelChannel).port] : [];
      this.send({ t: 'result', id: msg.id, ok: true, value }, transfer);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.send({ t: 'result', id: msg.id, ok: false, error, code: /^(E[A-Z]+):/.exec(error)?.[1] });
    }
  }
}

let main: Connection | null = null;

// ---- handshake -----------------------------------------------------------------
const allowed = (origin: string) => EMBED_ORIGINS === '*' || EMBED_ORIGINS.includes(origin) || origin === location.origin;

addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { type?: string; protocol?: number } | null;
  if (data?.type !== 'bbx:connect' || e.source !== parent || !e.ports[0]) return;
  const p = e.ports[0];
  if (main) return p.postMessage({ t: 'refused', error: 'this runtime is already connected; boot another BrowserBox for a second box' } satisfies FromRuntime);
  if (!allowed(e.origin)) return p.postMessage({ t: 'refused', error: `origin ${e.origin} may not use this runtime (VITE_EMBED_ORIGINS)` } satisfies FromRuntime);
  if (data.protocol !== PROTOCOL_VERSION) return p.postMessage({ t: 'refused', error: `protocol mismatch: the SDK speaks ${data.protocol}, this runtime ${PROTOCOL_VERSION}. Use matching versions of the SDK and the runtime.` } satisfies FromRuntime);
  const conn = (main = new Connection(p, firstLink));
  (globalThis as unknown as { bbx: RemoteKernel }).bbx = conn.os;
  void conn.hello().then(
    (h) => conn.send(h),
    (err: Error) => conn.send({ t: 'refused', error: `the runtime failed to start: ${err.message}` }),
  );
});

if (parent !== window) parent.postMessage({ type: 'bbx:embed-ready', protocol: PROTOCOL_VERSION }, '*');
