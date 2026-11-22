import { connectKernel } from '@/client/connect';
import { RemoteKernel } from '@/client/remote-kernel';
import { EMBED_ORIGINS } from '@/config/origins';
import type { PermDecision, PermRequest } from '@/kernel/perms';
import { fromSearch } from '@/kernel/instance';
import { HOME } from '@/kernel/paths';
import { plainText, stripAnsi } from '@/shell/ansi';
import type { ShellHandle } from '@/kernel/api';
import { PROTOCOL_VERSION, type DevServer, type ExecOptions, type ExecResult, type FromRuntime, type Hello, type Methods, type ToRuntime } from '../packages/sdk/src/protocol';

/**
 * The SDK runtime: a UI-less page that owns a BrowserBox kernel and lends it
 * to the page embedding it, over a MessagePort handed over in the handshake
 * (see packages/sdk/src/protocol.ts).
 *
 * Only this page needs the kernel, the worker and the wasm. The embedding page
 * loads the SDK client alone and needs no special headers.
 */
// Which box this page drives comes from its URL (embed/?box=<id>&storage=opfs|memory), set by the SDK.
// Without one it is the 'default' box: SDK pages never drive the app's own kernel.
const fromUrl = fromSearch(location.search);
const instance = { box: fromUrl.box ?? 'default', storage: fromUrl.box === null ? ('opfs' as const) : fromUrl.storage };
const os = new RemoteKernel(connectKernel({ instance }));
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;

let port: MessagePort | null = null;
const send = (msg: FromRuntime, transfer: Transferable[] = []) => port?.postMessage(msg, transfer);

// ---- permissions: asked of the embedding page ------------------------------
let nextAsk = 1;
const asks = new Map<number, (d: PermDecision) => void>();
os.perms.setPrompter(
  (req: PermRequest, signal?: AbortSignal) =>
    new Promise<PermDecision>((resolve) => {
      if (!port) return resolve('deny');
      const id = nextAsk++;
      asks.set(id, resolve);
      signal?.addEventListener('abort', () => asks.delete(id) && resolve('deny'));
      send({ t: 'permission', id, request: { cap: req.cap, actor: req.actor, title: req.title, detail: req.detail } });
    }),
);

// ---- processes ---------------------------------------------------------------
const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
let nextPid = 1;
const running = new Map<number, AbortController>();

type Io = { out(t: string): void; err(t: string): void };

/** Opens a confined shell (network needs the embedding page's permission) with extra variables. */
async function openShell(opts: { cwd?: string; env?: Record<string, string> }, err: (t: string) => void): Promise<ShellHandle> {
  const shell = await os.shells.open({ cwd: opts.cwd, confined: true });
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
async function runIn(shell: ShellHandle, command: string, timeoutMs: number | undefined, io: Io, ctl: AbortController): Promise<number> {
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
async function run(command: string, opts: ExecOptions, io: Io, ctl: AbortController): Promise<number> {
  let shell: ShellHandle;
  try {
    shell = await openShell(opts, io.err);
  } catch (err) {
    io.err(`${(err as Error).message}\n`);
    return 1;
  }
  try {
    return await runIn(shell, command, opts.timeoutMs, io, ctl);
  } finally {
    shell.close();
  }
}

/** Shell sessions the embedding page opened, by id. */
const sessions = new Map<number, { shell: ShellHandle; busy: boolean }>();
let nextSession = 1;
const streamTo = (pid: number): Io => ({
  out: (data) => send({ t: 'output', pid, stream: 'stdout', data: stripAnsi(data) }),
  err: (data) => send({ t: 'output', pid, stream: 'stderr', data: stripAnsi(data) }),
});

// ---- methods -----------------------------------------------------------------
const devInfo = ({ port, root, url, backend, network }: DevServer): DevServer => ({ port, root, url, backend, network });
type Impl = { [M in keyof Methods]: (...args: Parameters<Methods[M]>) => ReturnType<Methods[M]> | Promise<ReturnType<Methods[M]>> };

async function hello(): Promise<Hello> {
  await os.fs.ready;
  return { t: 'hello', protocol: PROTOCOL_VERSION, version: os.version, id: instance.box, home: HOME, caps: os.caps.filter((c) => c.ok).map((c) => c.id), storage: os.rootKind };
}

const methods: Impl = {
  info: hello,
  'fs.readFile': (path) => os.fs.readFile(path),
  'fs.readTextFile': (path) => os.fs.readText(path),
  'fs.writeFile': (path, data) => os.fs.writeFile(path, data),
  'fs.mkdir': (path) => os.fs.mkdir(path),
  'fs.readdir': async (path) => (await os.fs.readdir(path)).map(({ path, name, kind, size, mtime }) => ({ path, name, kind, size, mtime })),
  'fs.stat': async (path) => {
    const s = await os.fs.stat(path);
    return s && { path: s.path, name: s.name, kind: s.kind, size: s.size, mtime: s.mtime };
  },
  'fs.exists': (path) => os.fs.exists(path),
  'fs.rm': (path, opts) => os.fs.rm(path, opts),
  'fs.rename': (from, to) => os.fs.mv(from, to),
  'fs.cp': (from, to) => os.fs.cp(from, to),
  async exec(command, opts = {}): Promise<ExecResult> {
    let stdout = '';
    let stderr = '';
    const exitCode = await run(command, opts, { out: (t) => (stdout += t), err: (t) => (stderr += t) }, new AbortController());
    // Programs read plain text: no colour codes, and progress bars redrawn with \r collapse to their final line.
    return { exitCode, stdout: plainText(stdout), stderr: plainText(stderr) };
  },
  spawn(command, opts = {}) {
    const pid = nextPid++;
    const ctl = new AbortController();
    running.set(pid, ctl);
    void run(command, opts, streamTo(pid), ctl).then((exitCode) => {
      running.delete(pid);
      send({ t: 'exit', pid, exitCode });
    });
    return pid;
  },
  'fs.appendFile': (path, data) => os.fs.appendFile(path, data),
  'fs.glob': (pattern, cwd, limit) => os.fs.glob(pattern, cwd ?? HOME, limit),
  async 'shell.open'(opts = {}) {
    const shell = await openShell(opts, () => undefined);
    const id = nextSession++;
    sessions.set(id, { shell, busy: false });
    return { id, cwd: shell.cwd };
  },
  'shell.run'(id, command, opts = {}) {
    const s = sessions.get(id);
    if (!s) throw new Error(`no such shell session: ${id}`);
    if (s.busy) throw new Error('this shell session is still running a command');
    s.busy = true;
    const pid = nextPid++;
    const ctl = new AbortController();
    running.set(pid, ctl);
    void runIn(s.shell, command, opts.timeoutMs, streamTo(pid), ctl).then((exitCode) => {
      s.busy = false;
      running.delete(pid);
      send({ t: 'exit', pid, exitCode, cwd: s.shell.cwd });
    });
    return pid;
  },
  'shell.close'(id) {
    sessions.get(id)?.shell.close();
    sessions.delete(id);
  },
  'dev.start': ({ root, port, network }) => os.dev.start({ root, port, network }).then(devInfo),
  'dev.stop': (port) => os.dev.stop(port),
  'dev.list': async () => (await os.dev.list()).map(devInfo),
  'dev.logs': async (port, opts) => (await os.dev.logs(port, opts)).map(({ seq, t, level, source, text }) => ({ seq, t, level, source, text })),
  'procs.list': () => os.procs.list().map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, kind: p.kind, state: p.state, detail: p.detail, started: p.started, cpuMs: p.cpuMs, memBytes: p.memBytes })),
  'procs.kill': (pid) => os.procs.kill(pid, 'killed through the SDK'),
  kill(pid) {
    const ctl = running.get(pid);
    ctl?.abort();
    return !!ctl;
  },
};

async function onMessage(msg: ToRuntime): Promise<void> {
  if (msg.t === 'permission-answer') {
    asks.get(msg.id)?.(msg.decision);
    asks.delete(msg.id);
    return;
  }
  if (msg.t !== 'call') return;
  const fn = Object.hasOwn(methods, msg.method) ? (methods[msg.method] as (...a: unknown[]) => unknown) : null;
  try {
    if (!fn) throw new Error(`unknown method: ${msg.method}`);
    const value = await fn(...(Array.isArray(msg.args) ? msg.args : []));
    send({ t: 'result', id: msg.id, ok: true, value }, value instanceof Uint8Array ? [value.buffer] : []);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    send({ t: 'result', id: msg.id, ok: false, error, code: /^(E[A-Z]+):/.exec(error)?.[1] });
  }
}

// ---- handshake -----------------------------------------------------------------
const allowed = (origin: string) => EMBED_ORIGINS === '*' || EMBED_ORIGINS.includes(origin) || origin === location.origin;

addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { type?: string; protocol?: number } | null;
  if (data?.type !== 'bbx:connect' || e.source !== parent || !e.ports[0]) return;
  const p = e.ports[0];
  if (port) return p.postMessage({ t: 'refused', error: 'this runtime is already connected; boot another BrowserBox for a second box' } satisfies FromRuntime);
  if (!allowed(e.origin)) return p.postMessage({ t: 'refused', error: `origin ${e.origin} may not use this runtime (VITE_EMBED_ORIGINS)` } satisfies FromRuntime);
  if (data.protocol !== PROTOCOL_VERSION) return p.postMessage({ t: 'refused', error: `protocol mismatch: the SDK speaks ${data.protocol}, this runtime ${PROTOCOL_VERSION}. Use matching versions of the SDK and the runtime.` } satisfies FromRuntime);
  port = p;
  port.onmessage = (m: MessageEvent<ToRuntime>) => void onMessage(m.data);
  void hello().then(
    (h) => send(h),
    (err: Error) => send({ t: 'refused', error: `the runtime failed to start: ${err.message}` }),
  );
});

if (parent !== window) parent.postMessage({ type: 'bbx:embed-ready', protocol: PROTOCOL_VERSION }, '*');
