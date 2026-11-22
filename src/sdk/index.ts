/**
 * BrowserBox SDK: a sandboxed Linux-like computer for AI agents, in the
 * browser, with no backend.
 *
 *   import { BrowserBox } from '@jeevanand/browserbox';
 *   const box = await BrowserBox.boot();
 *   await box.fs.writeFile('hello.py', 'print("hi")');
 *   const { stdout } = await box.exec('python hello.py');
 *
 * `boot()` adds a hidden frame that loads the BrowserBox runtime (the kernel,
 * its filesystem, shell, Python, packages and agent). This package is only the
 * client: a few KB, no dependencies, and your page needs no special headers.
 */
import { PROTOCOL, type ClientMsg, type ProcEvent, type RuntimeInfo, type RuntimeMsg } from './protocol';

export type { RuntimeInfo } from './protocol';

/** Where the runtime is hosted by default. Self-host by serving the app's build and passing `runtimeUrl`. */
export const DEFAULT_RUNTIME_URL = 'https://jeevanandmaurya.github.io/agent-browserbox/embed/';

export interface BootOptions {
  /** The runtime page (…/embed/ of a BrowserBox build). */
  runtimeUrl?: string;
  /** Give up after this many milliseconds (default 30 000). */
  timeout?: number;
  /**
   * Decides what the agent may do (run commands, write files, use the
   * network). Default: allow, since everything happens inside the sandbox.
   */
  onPermission?: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
  /** Answers the agent's questions (its ask_user tool). Default: tells it to decide by itself. */
  onQuestion?: (question: string, options?: string[]) => string | Promise<string>;
}

export interface PermissionRequest {
  cap: 'fs.write' | 'exec' | 'net' | 'clipboard' | 'notify' | 'system';
  actor: string;
  title: string;
  detail: string;
}
export type PermissionDecision = 'once' | 'always' | 'deny';

export interface FileStat {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: number;
}

/** WebContainer-style file tree, for `mount`. */
export interface FileSystemTree {
  [name: string]: { file: { contents: string | Uint8Array } } | { directory: FileSystemTree };
}

export interface SpawnOptions {
  /** Working directory (default: the home folder, /home/agent). Relative paths are under it too. */
  cwd?: string;
}

export interface BoxProcess {
  /** stdout and stderr, as text, in order. */
  readonly output: ReadableStream<string>;
  /** Resolves with the exit code. */
  readonly exit: Promise<number>;
  /** Sends input to a command that reads from the terminal (a line per newline). */
  write(text: string): void;
  kill(): void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ModelConfig =
  | { provider: 'anthropic'; model?: string; apiKey: string }
  | { provider: 'openai'; model: string; apiKey: string; baseUrl?: string }
  | { provider: 'local'; model: string; baseUrl?: string; apiKey?: string }
  | { provider: 'webllm'; model?: string };

/** What the agent is doing, streamed while it works. */
export type AgentEvent =
  | { type: 'start'; model: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'status'; text: string }
  | { type: 'note'; text: string }
  | { type: 'tool_start'; id: string; name: string; summary: string; input: Record<string, unknown> }
  | { type: 'tool_progress'; id: string; chunk: string }
  | { type: 'tool_end'; id: string; result: string; isError: boolean; ms: number }
  | { type: 'todos'; items: Array<{ content: string; status: string }> }
  | { type: 'usage'; usage: Usage; total: Usage; model: string; context: { used: number; window: number } }
  | { type: 'compact'; before: number; after: number; auto: boolean }
  | { type: 'file_change'; id: string; diff: { path: string; added: number; removed: number } & Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'end' | 'stopped' | 'error' | 'max_steps' };

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface AgentSession {
  readonly id: string;
  /** Sends a message; resolves with the agent's final text when it has finished. `plan`: look around and propose, change nothing. */
  send(text: string, opts?: { plan?: boolean }): Promise<string>;
  /** Streams events (text, tool calls, file changes…). Returns an unsubscribe function. */
  on(fn: (e: AgentEvent) => void): () => void;
  stop(): void;
  /** The conversation so far. */
  messages(): Promise<unknown[]>;
  dispose(): void;
}

export class BoxError extends Error {
  /** ENOENT, EEXIST… for filesystem errors. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'BoxError';
    this.code = code;
  }
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void };

/** A running BrowserBox. Get one with `BrowserBox.boot()`. */
export class BrowserBox {
  /** Version, storage kind, isolation and platform features of the runtime. */
  readonly info: RuntimeInfo;
  readonly runtimeUrl: string;
  readonly #frame: HTMLIFrameElement;
  readonly #port: MessagePort;
  readonly #pending = new Map<number, Pending>();
  readonly #channels = new Map<string, Set<(d: unknown) => void>>();
  readonly #opts: BootOptions;
  #next = 1;
  #closed = false;

  /** Starts (or joins) the runtime. Files persist between visits when the browser allows it (`info.storage === 'opfs'`). */
  static async boot(opts: BootOptions = {}): Promise<BrowserBox> {
    if (typeof document === 'undefined') throw new BoxError('BrowserBox runs in a browser page (it needs the DOM to host its runtime frame).');
    const url = new URL(opts.runtimeUrl ?? DEFAULT_RUNTIME_URL, location.href);
    const origin = url.origin;
    const frame = document.createElement('iframe');
    frame.src = url.href;
    frame.title = 'BrowserBox runtime';
    frame.setAttribute('aria-hidden', 'true');
    // Lets the runtime be cross-origin isolated when this page is (real Node.js, SharedArrayBuffer).
    frame.allow = 'cross-origin-isolated';
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    const { port1, port2 } = new MessageChannel();
    let onWindowMessage: (e: MessageEvent) => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<RuntimeInfo>((resolve, reject) => {
      timer = setTimeout(() => reject(new BoxError(`The BrowserBox runtime at ${url.href} did not start within ${(opts.timeout ?? 30000) / 1000}s.`)), opts.timeout ?? 30000);
      onWindowMessage = (e) => {
        if (e.source !== frame.contentWindow || e.origin !== origin || e.data?.type !== 'bbx:runtime-ready') return;
        frame.contentWindow!.postMessage({ type: 'bbx:sdk-hello', protocol: PROTOCOL }, origin, [port2]);
      };
      addEventListener('message', onWindowMessage);
      port1.onmessage = (e: MessageEvent<RuntimeMsg | { t: 'refused'; reason: string }>) => {
        if (e.data.t === 'ready') resolve(e.data.info);
        else if (e.data.t === 'refused') reject(new BoxError(e.data.reason));
      };
    });
    (document.body ?? document.documentElement).append(frame);
    try {
      const info = await ready;
      return new BrowserBox(frame, port1, info, url.href, opts);
    } catch (err) {
      frame.remove();
      port1.close();
      throw err;
    } finally {
      clearTimeout(timer);
      removeEventListener('message', onWindowMessage);
    }
  }

  private constructor(frame: HTMLIFrameElement, port: MessagePort, info: RuntimeInfo, runtimeUrl: string, opts: BootOptions) {
    this.#frame = frame;
    this.#port = port;
    this.info = info;
    this.runtimeUrl = runtimeUrl;
    this.#opts = opts;
    port.onmessage = (e: MessageEvent<RuntimeMsg>) => this.#receive(e.data);
  }

  #receive(msg: RuntimeMsg): void {
    if (msg.t === 'res') {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.v);
      else p?.reject(new BoxError(msg.e, msg.code));
    } else if (msg.t === 'ev') {
      for (const fn of this.#channels.get(msg.ch) ?? []) fn(msg.d);
    } else if (msg.t === 'ask') {
      const answer = (v: unknown) => this.#post({ t: 'answer', id: msg.id, v });
      const run = async () => {
        if (msg.kind === 'perm') return this.#opts.onPermission ? this.#opts.onPermission(msg.payload as PermissionRequest) : 'once';
        const q = msg.payload as { question: string; options?: string[] };
        return this.#opts.onQuestion ? this.#opts.onQuestion(q.question, q.options) : 'No one can answer right now; make a sensible choice and say which.';
      };
      run().then(answer, () => answer(msg.kind === 'perm' ? 'deny' : ''));
    }
  }

  #post(msg: ClientMsg, transfer: Transferable[] = []): void {
    if (this.#closed) throw new BoxError('This BrowserBox was torn down.');
    this.#port.postMessage(msg, transfer);
  }

  #call<T>(m: string, ...a: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.#next++;
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.#post({ t: 'call', id, m, a });
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  #listen(ch: string, fn: (d: unknown) => void): () => void {
    let set = this.#channels.get(ch);
    if (!set) this.#channels.set(ch, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.#channels.delete(ch);
    };
  }

  /** The filesystem. Relative paths are under the home folder (/home/agent, the agent's workspace). */
  readonly fs = {
    readFile: ((path: string, encoding?: 'utf8' | 'utf-8') =>
      encoding ? this.#call<string>('fs.readText', path) : this.#call<Uint8Array>('fs.readFile', path)) as {
      (path: string): Promise<Uint8Array>;
      (path: string, encoding: 'utf8' | 'utf-8'): Promise<string>;
    },
    /** Creates missing parent folders. */
    writeFile: (path: string, data: string | Uint8Array) => this.#call<void>('fs.writeFile', path, data),
    appendFile: (path: string, data: string | Uint8Array) => this.#call<void>('fs.appendFile', path, data),
    readdir: (path: string) => this.#call<FileStat[]>('fs.readdir', path),
    stat: (path: string) => this.#call<FileStat | null>('fs.stat', path),
    exists: (path: string) => this.#call<boolean>('fs.exists', path),
    mkdir: (path: string, opts?: { recursive?: boolean }) => this.#call<void>('fs.mkdir', path, opts),
    rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => this.#call<void>('fs.rm', path, opts),
    rename: (from: string, to: string) => this.#call<void>('fs.rename', from, to),
    cp: (from: string, to: string) => this.#call<void>('fs.cp', from, to),
    /** Paths matching a glob such as `src/** /*.ts`, relative to `cwd`. */
    glob: (pattern: string, cwd?: string) => this.#call<string[]>('fs.glob', pattern, cwd),
  };

  /** Writes a whole file tree (the WebContainer format) under `mountPoint` (default: the home folder). Resolves with the number of files. */
  mount(tree: FileSystemTree, opts: { mountPoint?: string } = {}): Promise<number> {
    return this.#call('fs.mount', tree, opts.mountPoint);
  }

  /**
   * Runs a command in the BrowserBox shell: `spawn('ls -la')`, or
   * `spawn('npm', ['install'])` like WebContainers. The shell has pipes,
   * redirects, &&, ||, env vars, ~100 commands, python, pip, node (when
   * isolated), git, sqlite3 and more.
   */
  spawn(command: string, args?: string[] | SpawnOptions, opts?: SpawnOptions): Promise<BoxProcess> {
    const list = Array.isArray(args) ? args : [];
    const o = (Array.isArray(args) ? opts : args) ?? {};
    const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
    const line = [command, ...list.map(quote)].join(' ');
    const id = this.#next++;
    let controller!: ReadableStreamDefaultController<string>;
    let settle!: (code: number) => void;
    const output = new ReadableStream<string>({ start: (c) => void (controller = c) });
    const exit = new Promise<number>((r) => (settle = r));
    const off = this.#listen(`proc:${id}`, (d) => {
      const e = d as ProcEvent;
      if (e.k === 'exit') {
        off();
        try {
          controller.close();
        } catch {
          /* the reader cancelled */
        }
        settle(e.code);
      } else {
        try {
          controller.enqueue(e.s);
        } catch {
          /* the reader cancelled */
        }
      }
    });
    return this.#call<void>('proc.spawn', id, line, o).then(
      () => ({
        output,
        exit,
        write: (text: string) => void this.#call('proc.write', id, text),
        kill: () => void this.#call('proc.kill', id),
      }),
      (err: Error) => {
        off();
        throw err;
      },
    );
  }

  /** Runs a command to the end and collects its output. */
  async exec(command: string, opts: SpawnOptions = {}): Promise<ExecResult> {
    const id = this.#next++;
    let stdout = '';
    let stderr = '';
    const exitCode = new Promise<number>((resolve) => {
      const off = this.#listen(`proc:${id}`, (d) => {
        const e = d as ProcEvent;
        if (e.k === 'out') stdout += e.s;
        else if (e.k === 'err') stderr += e.s;
        else {
          off();
          resolve(e.code);
        }
      });
    });
    await this.#call('proc.spawn', id, command, opts);
    return { exitCode: await exitCode, stdout, stderr };
  }

  /** The AI agent that lives in the box: it uses the box's files, shell and tools. */
  readonly agent = {
    /** Chooses the model. API keys are stored encrypted inside the runtime and only sent to that provider. */
    configure: (model: ModelConfig & { mode?: 'auto' | 'ask' }) => this.#call<void>('agent.configure', model),
    /** Starts a conversation. Private by default: not saved in the runtime's chat history. */
    create: async (opts: { private?: boolean } = {}): Promise<AgentSession> => {
      const { sid } = await this.#call<{ sid: string }>('agent.create', opts);
      const fns = new Set<(e: AgentEvent) => void>();
      let text = '';
      const off = this.#listen(`agent:${sid}`, (d) => {
        const e = d as AgentEvent;
        if (e.type === 'start') text = '';
        else if (e.type === 'text') text += e.delta;
        else if (e.type === 'tool_start') text = ''; // the final answer is what comes after the last tool
        for (const fn of fns) fn(e);
      });
      return {
        id: sid,
        send: async (message, o) => {
          text = '';
          await this.#call('agent.send', sid, message, o);
          return text;
        },
        on: (fn) => (fns.add(fn), () => void fns.delete(fn)),
        stop: () => void this.#call('agent.stop', sid),
        messages: async () => (await this.#call<{ messages: unknown[] }>('agent.snapshot', sid)).messages,
        dispose: () => {
          off();
          fns.clear();
          void this.#call('agent.dispose', sid).catch(() => undefined);
        },
      };
    },
  };

  /**
   * Shows a BrowserBox window in your page: the agent app, the desktop or the
   * docs. It uses the same runtime (same files) as this box. Returns the frame.
   */
  ui(container: HTMLElement, view: 'agent' | 'desktop' | 'docs' = 'agent'): HTMLIFrameElement {
    const frame = document.createElement('iframe');
    frame.src = new URL(view === 'desktop' ? '../os/' : `../${view}/`, this.runtimeUrl).href;
    frame.title = `BrowserBox ${view}`;
    frame.allow = 'cross-origin-isolated; clipboard-read; clipboard-write; fullscreen';
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    container.append(frame);
    return frame;
  }

  /** Stops everything this client started and removes the runtime frame. Files stay. */
  teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new BoxError('This BrowserBox was torn down.'));
    this.#pending.clear();
    this.#channels.clear();
    this.#port.close();
    this.#frame.remove();
  }
}

export default BrowserBox;
