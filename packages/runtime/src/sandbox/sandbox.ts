import type { Kernel } from '../kernel/api';
import type { Proc } from '../kernel/proc';
import { resolve } from '../kernel/vfs/path';
import { KERNEL_URL } from '../config/origins';
import { embeddable } from './isolation';
import { PACKAGE_CACHE, PYODIDE_URL, PYTHON_RUNTIME_FILES } from './python-runtime';
import runtimeSrc from './runtime.js?raw';
import type { WireRequest, WireResponse } from '../kernel/dev/types';

export { PYODIDE_URL };

/** Settings key: packages installed with pip, reinstalled in each new interpreter. */
export const PIP_KEY = 'python.packages';


export interface RunOptions {
  cwd?: string;
  /** Environment variables visible to the program (`env` in JS, os.environ in Python). */
  env?: Record<string, string>;
  /** Download progress while a runtime is being fetched. */
  onProgress?: (p: { label: string; loaded: number; total: number }) => void;
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
  /** A dev-server backend's answer (null when it did not handle the request). */
  response?: WireResponse | null;
}

interface FileBlob {
  path: string;
  data: Uint8Array;
}

type Job =
  | { op: 'js'; code: string; args?: string[]; env?: Record<string, string> }
  | { op: 'python'; code: string; packages?: string[]; files?: FileBlob[]; pyodideUrl: string; env?: Record<string, string>; runtime?: FileBlob[] }
  | { op: 'wasm'; wasm: Uint8Array; args?: string[]; stdin?: string; name?: string; files?: FileBlob[]; cwd?: string; env?: Record<string, string> }
  | { op: 'server-load'; code: string; env?: Record<string, string> }
  | { op: 'server-request'; req: WireRequest; origin: string };

type Reply =
  | { id: number; type: 'stdout' | 'stderr'; data: string }
  | { id: number; type: 'progress'; label: string; loaded: number; total: number }
  | { id: number; type: 'rpc'; rid: number; method: string; params: unknown[] }
  | { id: number; type: 'done'; result?: { value?: string; exitCode?: number; files?: FileBlob[]; dirs?: string[]; deleted?: string[]; response?: WireResponse | null }; error?: string };

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
    const frame = (this.#frame = embeddable(document.createElement('iframe')));
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
        } else if (m.type === 'progress') {
          opts.onProgress?.({ label: m.label, loaded: m.loaded, total: m.total });
        } else if (m.type === 'rpc') {
          this.#rpc(cwd, m.method, m.params).then(
            (value) => port.postMessage({ type: 'rpc-result', rid: m.rid, value }),
            (err: Error) => port.postMessage({ type: 'rpc-result', rid: m.rid, error: err.message }),
          );
        } else if (m.type === 'done') {
          void (async () => {
            if (m.error) return finish({ error: m.error });
            try {
              // Deletions first (a file may be replaced by a folder of the same name), then folders, then files.
              for (const p of m.result?.deleted ?? []) await this.os.fs.rm(resolve(cwd, p), { recursive: true }).catch(() => undefined);
              for (const d of m.result?.dirs ?? []) await this.os.fs.mkdir(resolve(cwd, d));
              for (const f of m.result?.files ?? []) await this.os.fs.writeFile(resolve(cwd, f.path), f.data);
            } catch (err) {
              return finish({ error: `could not write files back: ${(err as Error).message}` });
            }
            const exitCode = m.result?.exitCode;
            finish({ ok: exitCode === undefined || exitCode === 0, value: m.result?.value, exitCode, response: m.result?.response });
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
  backend(op: BackendOp, id: string, payload: BackendPayload, opts: RunOptions): Promise<RunResult>;
}

export type BackendOp = 'load' | 'request' | 'stop';
export interface BackendPayload {
  code?: string;
  env?: Record<string, string>;
  network?: boolean;
  ppid?: number;
  req?: WireRequest;
  origin?: string;
}
let host: SandboxHost | null = null;
export function setSandboxHost(h: SandboxHost): void {
  host = h;
}

export async function runJs(os: Kernel, code: string, opts: RunOptions & { network?: boolean; args?: string[]; ppid?: number } = {}): Promise<RunResult> {
  if (host) return host.run('js', { code, args: opts.args, network: opts.network, ppid: opts.ppid, env: opts.env }, opts);
  const sb = new Sandbox(os, { name: 'js', network: opts.network, ppid: opts.ppid });
  try {
    return await sb.run({ op: 'js', code, args: opts.args, env: opts.env }, opts);
  } finally {
    sb.dispose();
  }
}

/**
 * Runs a WASI program. With `cwd`, the program sees that folder's files (copied
 * in, as for Python) and what it writes, creates or deletes there is written back.
 */
export async function runWasm(os: Kernel, wasm: Uint8Array, opts: RunOptions & { args?: string[]; stdin?: string; name?: string; ppid?: number } = {}): Promise<RunResult> {
  if (host) return host.run('wasm', { wasm, args: opts.args, stdin: opts.stdin, name: opts.name, ppid: opts.ppid, env: opts.env }, opts);
  const sb = new Sandbox(os, { name: opts.name ?? 'wasm', ppid: opts.ppid });
  try {
    const files = opts.cwd ? await snapshot(os, opts.cwd) : undefined;
    return await sb.run({ op: 'wasm', wasm, args: opts.args, stdin: opts.stdin, name: opts.name, files, cwd: opts.cwd, env: opts.env }, opts);
  } finally {
    sb.dispose();
  }
}

// Pyodide takes seconds to start, so one interpreter is kept warm and reused.
let python: Sandbox | null = null;
let pythonBooted = false;


/**
 * Reads the Python runtime from Cache Storage, where installing the python
 * package puts it. A sandbox runs in an opaque origin whose HTTP cache does not
 * persist, so without this the 10 MB runtime would be downloaded every session.
 */
async function cachedPythonRuntime(): Promise<FileBlob[] | undefined> {
  try {
    const cache = await caches.open(PACKAGE_CACHE);
    const files = await Promise.all(
      PYTHON_RUNTIME_FILES.map(async (name) => {
        const hit = await cache.match(PYODIDE_URL + name);
        return hit ? { path: name, data: new Uint8Array(await hit.arrayBuffer()) } : null;
      }),
    );
    return files.every((f) => f !== null) ? (files as FileBlob[]) : undefined;
  } catch {
    return undefined; // Cache Storage unavailable (e.g. another origin): fall back to the CDN
  }
}

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
  if (host) return host.run('python', { code, packages: opts.packages, env: opts.env }, opts);
  // Deliberately parentless: the warm interpreter outlives whichever app first used it.
  if (!python?.alive) {
    python = new Sandbox(os, { name: 'python', network: false });
    pythonBooted = false;
  }
  const cwd = opts.cwd ?? '/tmp';
  const files = await snapshot(os, cwd);
  // The interpreter's own files come from the Python pack's cache when it has been installed;
  // otherwise the sandbox downloads them from the CDN (and reports progress).
  const fresh = !pythonBooted;
  const runtime = fresh ? await cachedPythonRuntime() : undefined;
  // Packages installed with pip are reinstalled whenever a new interpreter starts (micropip caches the wheels).
  const saved = fresh ? os.settings.get<string[]>(PIP_KEY, []) : [];
  const packages = [...new Set([...saved, ...(opts.packages ?? [])])];
  const result = await python.run({ op: 'python', code, packages: packages.length ? packages : undefined, files, pyodideUrl: PYODIDE_URL, env: opts.env, runtime }, { timeoutMs: 180000, ...opts, cwd });
  pythonBooted = python.alive && !result.timedOut;
  return result;
}

// ---- Dev-server backends -------------------------------------------------------
// A project's server.ts stays loaded in its own sandbox between requests, so it
// can keep state in memory like a real server process.
const backends = new Map<string, Sandbox>();

export async function devBackend(os: Kernel, op: BackendOp, id: string, p: BackendPayload, opts: RunOptions = {}): Promise<RunResult> {
  if (host) return host.backend(op, id, p, opts);
  const none = (error?: string): RunResult => ({ ok: !error, stdout: '', stderr: '', ms: 0, error });
  if (op === 'stop') {
    backends.get(id)?.dispose();
    backends.delete(id);
    return none();
  }
  if (op === 'load') {
    backends.get(id)?.dispose();
    const sb = new Sandbox(os, { name: `backend :${id}`, network: p.network, ppid: p.ppid });
    backends.set(id, sb);
    const r = await sb.run({ op: 'server-load', code: p.code ?? '', env: p.env }, { ...opts, timeoutMs: 15000 });
    if (!r.ok) {
      sb.dispose();
      backends.delete(id);
    }
    return r;
  }
  const sb = backends.get(id);
  if (!sb?.alive || !p.req) return none('backend not loaded');
  return sb.run({ op: 'server-request', req: p.req, origin: p.origin ?? 'http://localhost' }, { ...opts, timeoutMs: opts.timeoutMs ?? 30000 });
}
