import type { Kernel } from '@/kernel/api';
import type { Proc } from '@/kernel/proc';
import { resolve } from '@/kernel/vfs/path';
import { KERNEL_URL } from '@/config/origins';
import runtimeSrc from './runtime.js?raw';

export const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/';

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Stringified return value, if any. */
  value?: string;
  error?: string;
  exitCode?: number;
  timedOut?: boolean;
  ms: number;
}

interface FileBlob {
  path: string;
  data: Uint8Array;
}

type Job =
  | { op: 'js'; code: string; args?: string[] }
  | { op: 'python'; code: string; packages?: string[]; files?: FileBlob[]; pyodideUrl: string }
  | { op: 'wasm'; wasm: Uint8Array; args?: string[]; stdin?: string; name?: string };

type Reply =
  | { id: number; type: 'stdout' | 'stderr'; data: string }
  | { id: number; type: 'rpc'; rid: number; method: string; params: unknown[] }
  | { id: number; type: 'done'; result?: { value?: string; exitCode?: number; files?: FileBlob[] }; error?: string };

const MAX_CAPTURE = 256 * 1024;

/**
 * One isolated execution environment.
 *
 * Isolation layers, outermost first:
 *  1. `<iframe sandbox="allow-scripts">` — an opaque origin, so untrusted code
 *     cannot touch the host's OPFS, IndexedDB (secrets), cookies or DOM.
 *  2. A CSP on the frame that blocks the network unless `network` was granted.
 *  3. A Worker inside the frame, so runaway code never blocks the UI and can
 *     be terminated by removing the frame.
 * The only way out is the message port, where the host exposes a small,
 * cwd-relative filesystem RPC backed by the VFS.
 */
export class Sandbox {
  readonly proc: Proc;
  #frame: HTMLIFrameElement;
  #port: Promise<MessagePort>;
  #nextId = 1;
  #dead = false;
  #listeners = new Map<number, (r: Reply) => void>();
  #onCrash: ((err: string) => void) | null = null;

  constructor(
    private os: Kernel,
    opts: { name: string; network?: boolean; ppid?: number },
  ) {
    this.proc = os.procs.spawn({
      name: opts.name,
      kind: 'sandbox',
      ppid: opts.ppid,
      detail: opts.network ? 'isolated worker · network allowed' : 'isolated worker · no network',
      onKill: () => this.#destroy(),
    });
    const frame = (this.#frame = document.createElement('iframe'));
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.display = 'none';
    frame.src = new URL(opts.network ? 'sandbox-net.html' : 'sandbox.html', KERNEL_URL).href;
    this.#port = new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('sandbox failed to start')), 15000);
      const onMsg = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow) return;
        if (e.data?.type === 'hello') {
          const ch = new MessageChannel();
          ch.port1.onmessage = (ev) => {
            if (ev.data?.type === 'ready') {
              clearTimeout(timer);
              ch.port1.onmessage = (m) => this.#listeners.get((m.data as Reply).id)?.(m.data as Reply);
              resolvePort(ch.port1);
            }
          };
          frame.contentWindow!.postMessage({ type: 'boot', src: runtimeSrc }, '*', [ch.port2]);
        } else if (e.data?.type === 'crash') {
          this.#onCrash?.(String(e.data.error));
        }
      };
      addEventListener('message', onMsg);
      this.proc.signal.addEventListener('abort', () => {
        removeEventListener('message', onMsg);
        clearTimeout(timer);
        reject(new Error('sandbox was killed'));
      });
    });
    this.#port.catch(() => undefined);
    document.body.append(frame);
  }

  get alive(): boolean {
    return !this.#dead;
  }

  #destroy(): void {
    this.#dead = true;
    this.#frame.remove(); // tears down the worker with it
  }

  dispose(): void {
    if (!this.#dead) this.os.procs.exit(this.proc.pid);
  }

  async run(job: Job, opts: RunOptions = {}): Promise<RunResult> {
    const started = performance.now();
    const cwd = opts.cwd ?? '/';
    let stdout = '';
    let stderr = '';
    const result = (r: Partial<RunResult>): RunResult => {
      const ms = performance.now() - started;
      this.os.procs.account(this.proc.pid, ms);
      return { ok: false, stdout, stderr, ms, ...r };
    };
    let port: MessagePort;
    try {
      port = await this.#port;
    } catch (err) {
      return result({ error: (err as Error).message });
    }
    const id = this.#nextId++;
    this.os.procs.update(this.proc.pid, { state: 'running' });

    return new Promise<RunResult>((done) => {
      const finish = (r: Partial<RunResult>, kill = false) => {
        clearTimeout(timer);
        this.#listeners.delete(id);
        this.#onCrash = null;
        opts.signal?.removeEventListener('abort', onAbort);
        this.proc.signal.removeEventListener('abort', onKilled);
        if (kill) this.dispose();
        else this.os.procs.update(this.proc.pid, { state: 'idle' });
        done(result(r));
      };
      const onAbort = () => finish({ error: 'aborted' }, true);
      const onKilled = () => finish({ error: 'sandbox was killed' });
      const timer = setTimeout(() => finish({ error: `timed out after ${opts.timeoutMs ?? 30000} ms`, timedOut: true }, true), opts.timeoutMs ?? 30000);
      opts.signal?.addEventListener('abort', onAbort);
      this.proc.signal.addEventListener('abort', onKilled);
      this.#onCrash = (error) => finish({ error }, true);

      this.#listeners.set(id, (m) => {
        if (m.type === 'stdout') {
          if (stdout.length < MAX_CAPTURE) stdout += m.data;
          opts.onStdout?.(m.data);
        } else if (m.type === 'stderr') {
          if (stderr.length < MAX_CAPTURE) stderr += m.data;
          opts.onStderr?.(m.data);
        } else if (m.type === 'rpc') {
          this.#rpc(cwd, m.method, m.params).then(
            (value) => port.postMessage({ type: 'rpc-result', rid: m.rid, value }),
            (err: Error) => port.postMessage({ type: 'rpc-result', rid: m.rid, error: err.message }),
          );
        } else if (m.type === 'done') {
          void (async () => {
            if (m.error) return finish({ error: m.error });
            try {
              for (const f of m.result?.files ?? []) await this.os.fs.writeFile(resolve(cwd, f.path), f.data);
            } catch (err) {
              return finish({ error: `could not write files back: ${(err as Error).message}` });
            }
            const exitCode = m.result?.exitCode;
            finish({ ok: exitCode === undefined || exitCode === 0, value: m.result?.value, exitCode });
          })();
        }
      });
      port.postMessage({ id, ...job });
    });
  }

  /** Filesystem bridge: every path is resolved against the run's cwd inside the VFS. */
  async #rpc(cwd: string, method: string, params: unknown[]): Promise<unknown> {
    const fs = this.os.fs;
    const p = (i = 0) => {
      if (typeof params[i] !== 'string') throw new Error(`${method}: path must be a string`);
      return resolve(cwd, params[i] as string);
    };
    switch (method) {
      case 'fs.readText':
        return fs.readText(p());
      case 'fs.readFile':
        return fs.readFile(p());
      case 'fs.writeFile':
        return fs.writeFile(p(), params[1] as string | Uint8Array);
      case 'fs.appendFile':
        return fs.appendFile(p(), params[1] as string | Uint8Array);
      case 'fs.readdir':
        return fs.readdir(p());
      case 'fs.exists':
        return fs.exists(p());
      case 'fs.mkdir':
        return fs.mkdir(p());
      case 'fs.rm':
        return fs.rm(p(), { recursive: true });
      case 'fs.glob':
        return fs.glob(String(params[0]), cwd);
      default:
        throw new Error(`unknown sandbox call: ${method}`);
    }
  }
}

/**
 * Sandboxes are frames, and frames need a document. The headless kernel has
 * none, so it installs a host that forwards each run to a window's bridge.
 */
export interface SandboxHost {
  run(kind: 'js' | 'python' | 'wasm', payload: Record<string, unknown>, opts: RunOptions): Promise<RunResult>;
}
let host: SandboxHost | null = null;
export function setSandboxHost(h: SandboxHost): void {
  host = h;
}

export async function runJs(os: Kernel, code: string, opts: RunOptions & { network?: boolean; args?: string[]; ppid?: number } = {}): Promise<RunResult> {
  if (host) return host.run('js', { code, args: opts.args, network: opts.network, ppid: opts.ppid }, opts);
  const sb = new Sandbox(os, { name: 'js', network: opts.network, ppid: opts.ppid });
  try {
    return await sb.run({ op: 'js', code, args: opts.args }, opts);
  } finally {
    sb.dispose();
  }
}

export async function runWasm(os: Kernel, wasm: Uint8Array, opts: RunOptions & { args?: string[]; stdin?: string; name?: string; ppid?: number } = {}): Promise<RunResult> {
  if (host) return host.run('wasm', { wasm, args: opts.args, stdin: opts.stdin, name: opts.name, ppid: opts.ppid }, opts);
  const sb = new Sandbox(os, { name: opts.name ?? 'wasm', ppid: opts.ppid });
  try {
    return await sb.run({ op: 'wasm', wasm, args: opts.args, stdin: opts.stdin, name: opts.name }, opts);
  } finally {
    sb.dispose();
  }
}

// Pyodide takes seconds to start, so one interpreter is kept warm and reused.
let python: Sandbox | null = null;

async function snapshot(os: Kernel, cwd: string): Promise<FileBlob[]> {
  const files: FileBlob[] = [];
  let budget = 24 * 1024 * 1024;
  for await (const s of os.fs.walk(cwd, { maxDepth: 6 })) {
    if (s.kind !== 'file' || s.size > 8 * 1024 * 1024 || s.size > budget) continue;
    budget -= s.size;
    files.push({ path: s.path.slice(cwd === '/' ? 1 : cwd.length + 1), data: await os.fs.readFile(s.path) });
    if (files.length >= 400) break;
  }
  return files;
}

/**
 * Runs Python (CPython on WebAssembly). Files under `cwd` are copied into the
 * interpreter's working directory and anything it writes is copied back.
 */
export async function runPython(os: Kernel, code: string, opts: RunOptions & { packages?: string[] } = {}): Promise<RunResult> {
  if (host) return host.run('python', { code, packages: opts.packages }, opts);
  // Deliberately parentless: the warm interpreter outlives whichever app first used it.
  if (!python?.alive) python = new Sandbox(os, { name: 'python', network: false });
  const cwd = opts.cwd ?? '/tmp';
  const files = await snapshot(os, cwd);
  return python.run({ op: 'python', code, packages: opts.packages, files, pyodideUrl: PYODIDE_URL }, { timeoutMs: 120000, ...opts, cwd });
}
