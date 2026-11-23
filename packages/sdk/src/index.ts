import {
  PROTOCOL_VERSION,
  type DevLogEntry,
  type DevServer,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type ProcessInfo,
  type FromRuntime,
  type Hello,
  type KernelChannel,
  type Method,
  type Methods,
  type PermissionDecision,
  type PermissionRequest,
  type ToRuntime,
} from './protocol.js';

export type { DevLogEntry, DevServer, ExecOptions, ExecResult, FileStat, KernelChannel, PermissionDecision, PermissionRequest, ProcessInfo };
export { PROTOCOL_VERSION };

/** This SDK's version. Always released together with the runtime of the same version. */
export const VERSION = '0.4.0';

/**
 * The hosted runtime of exactly this SDK's version. Released runtimes never
 * change, so a newer runtime can never break an app on this SDK. Self-host it
 * with @jeevanand/agent-browserbox-runtime.
 */
export const DEFAULT_RUNTIME_URL = `https://jeevanandmaurya.github.io/agent-browserbox/runtime/${VERSION}/`;

export type PermissionHandler = (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

export interface BootOptions {
  /** Base URL of the runtime (the folder holding embed/, kernel/, assets/). Default: the hosted runtime. */
  runtimeUrl?: string;
  /**
   * Which box. Each id is a separate machine with its own files, settings and
   * processes; booting the same id again (e.g. after a reload) reattaches to
   * its files. Letters, digits, '-' and '_'. Default: 'default', or a fresh id
   * for an in-memory box.
   */
  id?: string;
  /** 'persistent' (default): files survive reloads. 'memory': everything is gone when the box is torn down. */
  storage?: 'persistent' | 'memory';
  /**
   * Drive the site's own kernel instead of a box of its own: the one a
   * BrowserBox app hosted on the same site uses, with its files, settings and
   * keys. `id` and `storage` are ignored. (Other sites always get their own,
   * separate storage: browsers partition it by the top-level site.)
   */
  site?: boolean;
  /**
   * With `site`: which profile of the site to drive. Each profile has its own
   * files, settings and keys; omitted or 'default' is the first one.
   */
  profile?: string;
  /** Element the hidden runtime frame is added to. Default: document.body. */
  container?: HTMLElement;
  /**
   * What to answer when code in the box asks for a capability (network access,
   * …). 'deny' (default), 'allow', or a function deciding per request.
   */
  permissions?: 'deny' | 'allow' | PermissionHandler;
  /** Give up booting after this many ms. Default 30000. */
  timeoutMs?: number;
}

/** An error from the box. `code` is set for filesystem errors (ENOENT, EEXIST, …). */
export class BoxError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BoxError';
  }
}

interface Sink {
  out: ReadableStreamDefaultController<string>[];
  stdout: ReadableStreamDefaultController<string>[];
  stderr: ReadableStreamDefaultController<string>[];
  exit(code: number, cwd?: string): void;
}

type ProcEvent = { t: 'output'; stream: 'stdout' | 'stderr'; data: string } | { t: 'exit'; exitCode: number; cwd?: string };

/** A running command in the box. */
export class BoxProcess {
  /** stdout and stderr together, in the order they were written. */
  readonly output: ReadableStream<string>;
  readonly stdout: ReadableStream<string>;
  readonly stderr: ReadableStream<string>;
  /** Resolves with the exit code (124: timed out, 130: killed). */
  readonly exit: Promise<number>;

  /** @internal */
  constructor(
    readonly pid: number,
    private box: BrowserBox,
    attach: (sink: Sink) => void,
    onExit?: (code: number, cwd?: string) => void,
  ) {
    const sink: Sink = { out: [], stdout: [], stderr: [], exit: () => undefined };
    const stream = (list: ReadableStreamDefaultController<string>[]) => new ReadableStream<string>({ start: (c) => void list.push(c) });
    this.output = stream(sink.out);
    this.stdout = stream(sink.stdout);
    this.stderr = stream(sink.stderr);
    this.exit = new Promise((resolve) => (sink.exit = (code, cwd) => (onExit?.(code, cwd), resolve(code))));
    attach(sink);
  }

  /** Stops the command. Resolves false if it had already finished. */
  kill(): Promise<boolean> {
    return this.box.call('kill', this.pid);
  }
}

/** Reads a stream to the end. */
async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/** Collapses progress bars redrawn with \r to their final state, as exec() does. */
const settle = (text: string) =>
  text
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1))
    .join('\n');

/**
 * A shell session in the box: like a terminal, it keeps its working folder
 * and variables between commands (`cd`, `export`).
 */
export class BoxShell {
  /** The working folder, as of the last command. */
  cwd: string;

  /** @internal */
  constructor(
    readonly id: number,
    cwd: string,
    private box: BrowserBox,
  ) {
    this.cwd = cwd;
  }

  /** Starts a command line and streams its output. One command at a time per session. */
  async run(command: string, opts: { timeoutMs?: number } = {}): Promise<BoxProcess> {
    const pid = await this.box.call('shell.run', this.id, command, opts);
    return this.box._process(pid, (_code, cwd) => {
      if (cwd) this.cwd = cwd;
    });
  }

  /** Runs a command line to completion and returns its output. */
  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const p = await this.run(command, opts);
    const [stdout, stderr, exitCode] = await Promise.all([readAll(p.stdout), readAll(p.stderr), p.exit]);
    return { exitCode, stdout: settle(stdout), stderr: settle(stderr) };
  }

  close(): Promise<void> {
    return this.box.call('shell.close', this.id);
  }
}

/** The box's filesystem. Paths are absolute, or relative to the box's home. */
export class BoxFs {
  /** @internal */
  constructor(private box: BrowserBox) {}

  #abs(path: string): string {
    return path.startsWith('/') ? path : `${this.box.home.replace(/\/$/, '')}/${path}`;
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.box.call('fs.readFile', this.#abs(path));
  }
  readTextFile(path: string): Promise<string> {
    return this.box.call('fs.readTextFile', this.#abs(path));
  }
  /** Creates parent folders as needed. */
  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.box.call('fs.writeFile', this.#abs(path), data);
  }
  /** Creates parent folders as needed. */
  mkdir(path: string): Promise<void> {
    return this.box.call('fs.mkdir', this.#abs(path));
  }
  readdir(path = '.'): Promise<FileStat[]> {
    return this.box.call('fs.readdir', this.#abs(path));
  }
  /** Null when nothing is there. */
  stat(path: string): Promise<FileStat | null> {
    return this.box.call('fs.stat', this.#abs(path));
  }
  exists(path: string): Promise<boolean> {
    return this.box.call('fs.exists', this.#abs(path));
  }
  rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.box.call('fs.rm', this.#abs(path), opts);
  }
  rename(from: string, to: string): Promise<void> {
    return this.box.call('fs.rename', this.#abs(from), this.#abs(to));
  }
  cp(from: string, to: string): Promise<void> {
    return this.box.call('fs.cp', this.#abs(from), this.#abs(to));
  }
  /** Creates the file if needed. */
  appendFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.box.call('fs.appendFile', this.#abs(path), data);
  }
  /** Absolute paths of the files under `cwd` (default: home) that match a glob ('**', '*', '?', '{a,b}'). */
  glob(pattern: string, opts: { cwd?: string; limit?: number } = {}): Promise<string[]> {
    return this.box.call('fs.glob', pattern, this.#abs(opts.cwd ?? '.'), opts.limit);
  }
}

/**
 * Dev servers for project folders: bundling TS/JSX, reloading on save, and a
 * backend (server.ts) when the project has one. Nothing listens on a real
 * port; the app shows a server's pages through the runtime.
 */
export class BoxDev {
  /** @internal */
  constructor(private box: BrowserBox) {}

  /** Starts a server for a project folder, or returns the one already serving it. */
  start(root: string, opts: { port?: number; network?: boolean } = {}): Promise<DevServer> {
    return this.box.call('dev.start', { root: root.startsWith('/') ? root : `${this.box.home.replace(/\/$/, '')}/${root}`, ...opts });
  }
  stop(port: number): Promise<boolean> {
    return this.box.call('dev.stop', port);
  }
  list(): Promise<DevServer[]> {
    return this.box.call('dev.list');
  }
  /** Console output, server logs, build errors and failed requests, oldest first. */
  logs(port: number, opts: { after?: number; limit?: number } = {}): Promise<DevLogEntry[]> {
    return this.box.call('dev.logs', port, opts);
  }
}

/**
 * A sandboxed computer in the browser: a filesystem, a shell, and JavaScript,
 * Python and WebAssembly runtimes, all inside a hidden frame on the runtime's
 * origin. Nothing in it can reach the embedding page.
 *
 *   const box = await BrowserBox.boot();
 *   await box.fs.writeFile('hello.py', 'print(6 * 7)');
 *   const { stdout } = await box.exec('python hello.py');
 */
export class BrowserBox {
  readonly fs = new BoxFs(this);
  readonly dev = new BoxDev(this);
  /** Runtime version. */
  readonly version: string;
  /** This box's id. */
  readonly id: string;
  /** Default working directory; relative paths resolve against it. */
  readonly home: string;
  /** Platform features the runtime has (e.g. 'opfs', 'webgpu'). */
  readonly caps: readonly string[];
  /** 'opfs': files persist across reloads (separately for each embedding site). 'memory': they do not. */
  readonly storage: 'opfs' | 'memory';

  #port: MessagePort;
  #frame: HTMLIFrameElement | null;
  #permissions: PermissionHandler;
  #nextId = 1;
  #calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  #sinks = new Map<number, Sink>();
  /** Events for processes whose spawn() has not returned yet. */
  #early = new Map<number, ProcEvent[]>();
  #closed: BoxError | null = null;

  private constructor(port: MessagePort, frame: HTMLIFrameElement | null, hello: Hello, permissions: PermissionHandler) {
    this.#port = port;
    this.#frame = frame;
    this.#permissions = permissions;
    this.version = hello.version;
    this.id = hello.id;
    this.home = hello.home;
    this.caps = hello.caps;
    this.storage = hello.storage;
    port.onmessage = (e: MessageEvent<FromRuntime>) => this.#onMessage(e.data);
  }

  /** Starts a box: loads the runtime in a hidden frame and connects to it. */
  static boot(opts: BootOptions = {}): Promise<BrowserBox> {
    const base = new URL(opts.runtimeUrl ?? DEFAULT_RUNTIME_URL, globalThis.location?.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const memory = opts.storage === 'memory';
    const id = opts.id ?? (memory ? `mem-${crypto.randomUUID()}` : 'default');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return Promise.reject(new BoxError(`invalid box id "${id}": use letters, digits, '-' and '_' (at most 64)`));
    if (opts.profile !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(opts.profile)) return Promise.reject(new BoxError(`invalid profile id "${opts.profile}"`));
    const profile = opts.profile && opts.profile !== 'default' ? `&profile=${encodeURIComponent(opts.profile)}` : '';
    const src = new URL(opts.site ? `embed/?site=1${profile}` : `embed/?box=${encodeURIComponent(id)}&storage=${memory ? 'memory' : 'opfs'}`, base);
    const permissions: PermissionHandler = typeof opts.permissions === 'function' ? opts.permissions : opts.permissions === 'allow' ? () => 'once' : () => 'deny';

    const frame = document.createElement('iframe');
    frame.src = src.href;
    frame.title = 'BrowserBox runtime';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';

    return new Promise<BrowserBox>((resolve, reject) => {
      const fail = (message: string) => {
        cleanup();
        frame.remove();
        reject(new BoxError(message));
      };
      const timer = setTimeout(() => fail(`the runtime at ${src.href} did not respond within ${opts.timeoutMs ?? 30000} ms`), opts.timeoutMs ?? 30000);
      const onWindowMessage = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || e.origin !== src.origin || e.data?.type !== 'bbx:embed-ready') return;
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = (m: MessageEvent<FromRuntime>) => {
          const msg = m.data;
          if (msg.t === 'refused') return fail(`the runtime refused to connect: ${msg.error}`);
          if (msg.t !== 'hello') return;
          cleanup();
          resolve(new BrowserBox(port1, frame, msg, permissions));
        };
        frame.contentWindow!.postMessage({ type: 'bbx:connect', protocol: PROTOCOL_VERSION }, src.origin, [port2]);
      };
      const cleanup = () => {
        clearTimeout(timer);
        removeEventListener('message', onWindowMessage);
      };
      addEventListener('message', onWindowMessage);
      (opts.container ?? document.body).append(frame);
    });
  }

  /** Runs a shell command line to completion and returns its output. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.call('exec', command, opts);
  }

  /** Starts a shell command line and streams its output. */
  async spawn(command: string, opts?: ExecOptions): Promise<BoxProcess> {
    return this._process(await this.call('spawn', command, opts));
  }

  /**
   * Connects to a box shared with you (`box.share()`), e.g. from a worker,
   * which cannot create the runtime's frame itself. `teardown()` then closes
   * only this connection.
   */
  static attach(port: MessagePort, opts: Pick<BootOptions, 'permissions' | 'timeoutMs'> = {}): Promise<BrowserBox> {
    const permissions: PermissionHandler = typeof opts.permissions === 'function' ? opts.permissions : opts.permissions === 'allow' ? () => 'once' : () => 'deny';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BoxError(`the shared box did not respond within ${opts.timeoutMs ?? 30000} ms`)), opts.timeoutMs ?? 30000);
      port.onmessage = (m: MessageEvent<FromRuntime>) => {
        const msg = m.data;
        if (msg.t === 'refused') {
          clearTimeout(timer);
          reject(new BoxError(`the shared box refused: ${msg.error}`));
        } else if (msg.t === 'hello') {
          clearTimeout(timer);
          resolve(new BrowserBox(port, null, msg, permissions));
        }
      };
      port.start();
    });
  }

  /**
   * A second connection to this box, with its own shells and processes, to
   * hand to a worker (transfer the port, then `BrowserBox.attach(port)` there).
   */
  share(): Promise<MessagePort> {
    return this.call('share');
  }

  /**
   * A port to the box's kernel itself, speaking its full internal protocol,
   * for app UIs that need more than this API (the BrowserBox app uses it).
   * The protocol is versioned with the runtime: pin the runtime version.
   */
  kernelPort(): Promise<KernelChannel> {
    return this.call('kernel.connect');
  }

  /** Opens a shell session that keeps its working folder and variables between commands. */
  async openShell(opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<BoxShell> {
    const { id, cwd } = await this.call('shell.open', opts);
    return new BoxShell(id, cwd, this);
  }

  /** The box's process table: shells, sandboxes, dev servers and so on. */
  processes(): Promise<ProcessInfo[]> {
    return this.call('procs.list');
  }

  /** Stops a process from `processes()`. Resolves false if there was none with that id. */
  killProcess(pid: number): Promise<boolean> {
    return this.call('procs.kill', pid);
  }

  /** @internal Wraps a runtime process id whose events are routed here. */
  _process(pid: number, onExit?: (code: number, cwd?: string) => void): BoxProcess {
    return new BoxProcess(
      pid,
      this,
      (sink) => {
        this.#sinks.set(pid, sink);
        for (const ev of this.#early.get(pid) ?? []) this.#deliver(pid, ev);
        this.#early.delete(pid);
      },
      onExit,
    );
  }

  /** Shuts the box down: removes its frame and fails anything still pending. */
  teardown(): void {
    if (this.#closed) return;
    this.#closed = new BoxError('the box was torn down');
    for (const c of this.#calls.values()) c.reject(this.#closed);
    this.#calls.clear();
    for (const pid of [...this.#sinks.keys()]) this.#deliver(pid, { t: 'exit', exitCode: 130 });
    this.#port.close();
    this.#frame?.remove();
  }

  /** @internal Low-level call into the runtime. */
  call<M extends Method>(method: M, ...args: Parameters<Methods[M]>): Promise<ReturnType<Methods[M]>> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#port.postMessage({ t: 'call', id, method, args } satisfies ToRuntime);
    });
  }

  #onMessage(msg: FromRuntime): void {
    switch (msg.t) {
      case 'result': {
        const c = this.#calls.get(msg.id);
        this.#calls.delete(msg.id);
        if (msg.ok) c?.resolve(msg.value);
        else c?.reject(new BoxError(msg.error, msg.code));
        return;
      }
      case 'output':
        return this.#route(msg.pid, { t: 'output', stream: msg.stream, data: msg.data });
      case 'exit':
        return this.#route(msg.pid, { t: 'exit', exitCode: msg.exitCode, cwd: msg.cwd });
      case 'permission':
        void Promise.resolve()
          .then(() => this.#permissions(msg.request))
          .catch((): PermissionDecision => 'deny')
          .then((decision) => this.#port.postMessage({ t: 'permission-answer', id: msg.id, decision } satisfies ToRuntime));
        return;
    }
  }

  #route(pid: number, ev: ProcEvent): void {
    if (this.#sinks.has(pid)) return this.#deliver(pid, ev);
    const list = this.#early.get(pid) ?? [];
    list.push(ev);
    this.#early.set(pid, list);
  }

  #deliver(pid: number, ev: ProcEvent): void {
    const sink = this.#sinks.get(pid);
    if (!sink) return;
    // A stream the reader cancelled throws on enqueue/close; that reader just stops getting data.
    const each = (list: ReadableStreamDefaultController<string>[], fn: (c: ReadableStreamDefaultController<string>) => void) => {
      for (const c of list) {
        try {
          fn(c);
        } catch {
          /* cancelled */
        }
      }
    };
    if (ev.t === 'output') return each([...sink.out, ...sink[ev.stream]], (c) => c.enqueue(ev.data));
    each([...sink.out, ...sink.stdout, ...sink.stderr], (c) => c.close());
    this.#sinks.delete(pid);
    sink.exit(ev.exitCode, ev.cwd);
  }
}
