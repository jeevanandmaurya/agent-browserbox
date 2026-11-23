import { mimeOf } from '../filetypes';
import { devBackend } from '../../sandbox/sandbox';
import { basename, extname, isInside, join, normalize } from '../vfs/path';
import type { KernelCore } from '../kernel';
import { bundle } from './bundle';
import { renderHtml } from './html';
import type { PackageJson } from './npm';
import type { DevApi, DevInfo, DevLog, DevPage, DevStartOptions, WireRequest, WireResponse } from './types';

const FIRST_PORT = 3000;
const MAX_LOGS = 500;
/** Files that make a project's backend, in order of preference. */
export const BACKEND_FILES = ['server.ts', 'server.js', 'server.mjs', 'api/index.ts', 'api/index.js'];

interface Server {
  info: DevInfo;
  logs: DevLog[];
  seq: number;
  /** The backend is (re)built and loaded on the next request when false. */
  backendReady: boolean;
  backendInputs: Set<string>;
  /** Backend requests run one at a time. */
  queue: Promise<unknown>;
}

interface ProjectConfig {
  pkg: PackageJson | null;
  tsconfig: Parameters<typeof bundle>[0]['tsconfig'];
  /** .env files plus the user's environment variables. */
  env: Record<string, string>;
}

/** JSON with comments and trailing commas, as tsconfig.json allows. */
function parseJsonc(text: string): unknown {
  const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const text = (status: number, body: string, type = 'text/plain; charset=utf-8'): WireResponse => ({ status, headers: [['content-type', type]], body: new TextEncoder().encode(body) });

/**
 * Dev servers for project folders. Each is a process (`serve :3000`) whose
 * pages are built on request: scripts are bundled with esbuild, npm packages
 * come from esm.sh, and requests the page makes are answered from the
 * project's files or by its backend, which runs in a sandbox.
 */
export class DevServers implements DevApi {
  #servers = new Map<number, Server>();

  constructor(private os: KernelCore) {
    os.bus.on('proc:exit', ({ proc }) => {
      for (const [port, s] of this.#servers) {
        if (s.info.pid !== proc.pid) continue;
        this.#servers.delete(port);
        void devBackend(os, 'stop', String(port), {});
        this.#changed();
      }
    });
    os.bus.on('fs:change', ({ path }) => {
      for (const s of this.#servers.values()) {
        if (!isInside(s.info.root, path)) continue;
        const rel = path.slice(s.info.root.length + 1);
        if (s.backendInputs.has(path) || BACKEND_FILES.includes(rel) || rel === 'package.json' || rel.startsWith('.env')) s.backendReady = false;
      }
    });
  }

  #changed(): void {
    this.os.bus.emit('dev:update', [...this.#servers.values()].map((s) => ({ ...s.info })));
  }

  #get(port: number): Server {
    const s = this.#servers.get(port);
    if (!s) throw new Error(`nothing is serving on port ${port} (see: serve list)`);
    return s;
  }

  async start(o: DevStartOptions): Promise<DevInfo> {
    const root = normalize(o.root);
    const st = await this.os.fs.stat(root);
    if (st?.kind !== 'dir') throw new Error(`${root} is not a folder`);
    for (const s of this.#servers.values()) if (s.info.root === root) return { ...s.info };
    let port = o.port ?? FIRST_PORT;
    if (o.port !== undefined && this.#servers.has(port)) throw new Error(`port ${port} is in use by ${this.#servers.get(port)!.info.root}`);
    while (this.#servers.has(port)) port++;
    const proc = this.os.procs.spawn({ name: `serve :${port}`, kind: 'service', ppid: o.ppid, detail: root });
    this.os.procs.update(proc.pid, { state: 'idle' });
    const info: DevInfo = { port, root, pid: proc.pid, url: `http://localhost:${port}/`, backend: await this.#backendFile(root), network: !!o.network };
    this.#servers.set(port, { info, logs: [], seq: 0, backendReady: false, backendInputs: new Set(), queue: Promise.resolve() });
    this.os.log('dev', `serving ${root} on :${port}${info.backend ? ` (backend ${info.backend})` : ''}`);
    this.#changed();
    return { ...info };
  }

  async stop(port: number): Promise<boolean> {
    const s = this.#servers.get(port);
    if (!s) return false;
    this.os.procs.kill(s.info.pid, 'stopped');
    // The process exit handler removes it; make sure it is gone even if the pid was already reaped.
    this.#servers.delete(port);
    void devBackend(this.os, 'stop', String(port), {});
    this.#changed();
    return true;
  }

  async list(): Promise<DevInfo[]> {
    return [...this.#servers.values()].map((s) => ({ ...s.info }));
  }

  log(port: number, entries: Array<Pick<DevLog, 'level' | 'source' | 'text'>>): void {
    const s = this.#servers.get(port);
    if (!s) return;
    for (const e of entries) {
      const entry: DevLog = { seq: ++s.seq, t: Date.now(), level: e.level, source: e.source, text: String(e.text).slice(0, 8000) };
      s.logs.push(entry);
      if (s.logs.length > MAX_LOGS) s.logs.shift();
      this.os.bus.emit('dev:log', { port, entry });
    }
  }

  async logs(port: number, opts: { after?: number; limit?: number } = {}): Promise<DevLog[]> {
    const list = this.#get(port).logs.filter((l) => l.seq > (opts.after ?? 0));
    return opts.limit ? list.slice(-opts.limit) : list;
  }

  async #config(root: string): Promise<ProjectConfig> {
    const read = (name: string) => this.os.fs.readText(join(root, name)).catch(() => null);
    const [pkgText, tsText, jsText, ...envs] = await Promise.all([read('package.json'), read('tsconfig.json'), read('jsconfig.json'), read('.env'), read('.env.development'), read('.env.local')]);
    const parse = <T>(t: string | null, what: string): T | null => {
      if (!t) return null;
      try {
        return parseJsonc(t) as T;
      } catch (err) {
        throw new Error(`${what} is not valid JSON: ${(err as Error).message}`);
      }
    };
    const env: Record<string, string> = { ...this.os.settings.get<Record<string, string>>('env.vars', {}) };
    for (const e of envs) if (e) Object.assign(env, parseDotenv(e));
    return { pkg: parse<PackageJson>(pkgText, 'package.json'), tsconfig: parse(tsText ?? jsText, tsText ? 'tsconfig.json' : 'jsconfig.json'), env };
  }

  async #isFile(p: string): Promise<boolean> {
    return (await this.os.fs.stat(p).catch(() => null))?.kind === 'file';
  }

  async #backendFile(root: string): Promise<string | null> {
    for (const f of BACKEND_FILES) if (await this.#isFile(join(root, f))) return f;
    return null;
  }

  async page(port: number, path = '/'): Promise<DevPage> {
    const s = this.#get(port);
    const root = s.info.root;
    const clean = normalize(decodeURIComponent(path.split(/[?#]/)[0] || '/'));
    const target = join(root, clean);
    let htmlPath: string | null = null;
    const st = await this.os.fs.stat(target).catch(() => null);
    if (st?.kind === 'dir' && (await this.#isFile(join(target, 'index.html')))) htmlPath = join(target, 'index.html');
    else if (st?.kind === 'file' && /\.html?$/i.test(target)) htmlPath = target;
    else if (await this.#isFile(`${target}.html`)) htmlPath = `${target}.html`;
    else if (st?.kind === 'file') {
      // A file that is not a page: show it the way a browser would.
      const body = mimeOf(target).startsWith('image/')
        ? `<img src="${clean}" alt="" style="max-width:100%">`
        : `<pre id="t" style="white-space:pre-wrap;font:13px ui-monospace,monospace"></pre><script>fetch(${JSON.stringify(clean)}).then(r=>r.text()).then(t=>document.getElementById('t').textContent=t)</script>`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${basename(target)}</title></head><body style="margin:0;padding:12px">${body}</body></html>`;
      return renderHtml(this.os.fs, { root, htmlPath: null, html, path: clean, port, bundle: async () => ({ js: '', css: '', errors: [], warnings: [], inputs: [] }) });
    }
    // Client-side routes (/about, /users/7) get the app's index page, as dev servers do.
    if (!htmlPath && st?.kind !== 'file' && (await this.#isFile(join(root, 'index.html')))) htmlPath = join(root, 'index.html');

    let cfg: ProjectConfig;
    try {
      cfg = await this.#config(root);
    } catch (err) {
      cfg = { pkg: null, tsconfig: null, env: {} };
      this.log(port, [{ level: 'error', source: 'build', text: (err as Error).message }]);
    }
    const publicEnv = Object.fromEntries(Object.entries(cfg.env).filter(([k]) => /^(VITE_|PUBLIC_)/.test(k)));
    const started = performance.now();
    const out = await renderHtml(this.os.fs, {
      root,
      htmlPath,
      path: clean + (path.includes('?') ? path.slice(path.indexOf('?')) : ''),
      port,
      bundle: (entry) => bundle({ fs: this.os.fs, root, entry, target: 'browser', env: publicEnv, pkg: cfg.pkg, tsconfig: cfg.tsconfig }),
    });
    this.os.procs.account(s.info.pid, performance.now() - started);
    if (out.errors.length) this.log(port, out.errors.map((t) => ({ level: 'error' as const, source: 'build' as const, text: t })));
    return { html: out.html, errors: out.errors };
  }

  async request(port: number, req: WireRequest): Promise<WireResponse> {
    const s = this.#get(port);
    const root = s.info.root;
    const u = new URL(req.url, 'http://localhost');
    let rel: string;
    try {
      rel = decodeURIComponent(u.pathname);
    } catch {
      return text(400, 'Bad request');
    }
    const target = join(root, rel);
    const hidden = target.slice(root.length).split('/').some((part) => part.startsWith('.'));
    if (isInside(root, target) && !hidden && /^(GET|HEAD)$/i.test(req.method)) {
      let file = target;
      const st = await this.os.fs.stat(file).catch(() => null);
      if (st?.kind === 'dir') file = join(file, 'index.html');
      if (await this.#isFile(file)) {
        const body = req.method.toUpperCase() === 'HEAD' ? null : await this.os.fs.readFile(file);
        return { status: 200, headers: [['content-type', mimeOf(file) + (/^text\/|json|javascript|xml/.test(mimeOf(file)) ? '; charset=utf-8' : '')]], body };
      }
    }
    if (!s.backendReady) s.info.backend = await this.#backendFile(root);
    if (s.info.backend) {
      const run = s.queue.then(() => this.#backend(s, req, u));
      s.queue = run.catch(() => undefined);
      return run;
    }
    this.log(port, [{ level: 'warn', source: 'network', text: `${req.method} ${req.url} → 404 (no such file${extname(rel) ? '' : ', and no backend: add server.ts to answer requests'})` }]);
    return text(404, `Not found: ${rel}`);
  }

  async #loadBackend(s: Server): Promise<string | null> {
    const { root, port, pid, network } = s.info;
    const cfg = await this.#config(root);
    const out = await bundle({ fs: this.os.fs, root, entry: join(root, s.info.backend!), target: 'server', env: cfg.env, pkg: cfg.pkg, tsconfig: cfg.tsconfig });
    s.backendInputs = new Set(out.inputs);
    if (out.errors.length) return `The backend (${s.info.backend}) failed to build:\n\n${out.errors.join('\n\n')}`;
    const r = await devBackend(this.os, 'load', String(port), { code: out.js, env: cfg.env, network, ppid: pid }, { cwd: root, onStdout: (t) => this.#serverLog(port, 'log', t), onStderr: (t) => this.#serverLog(port, 'error', t) });
    if (!r.ok) return `The backend (${s.info.backend}) failed to start: ${r.error ?? r.stderr}`;
    s.backendReady = true;
    this.os.log('dev', `:${port} backend ${s.info.backend} loaded`);
    return null;
  }

  #serverLog(port: number, level: 'log' | 'error', chunk: string): void {
    const lines = chunk.replace(/\n$/, '');
    if (lines) this.log(port, [{ level, source: 'server', text: lines }]);
  }

  async #backend(s: Server, req: WireRequest, u: URL): Promise<WireResponse> {
    const { port, root } = s.info;
    const fail = (msg: string) => {
      this.log(port, [{ level: 'error', source: 'server', text: msg }]);
      return text(500, msg);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!s.backendReady) {
        const err = await this.#loadBackend(s);
        if (err) return fail(err);
      }
      const started = performance.now();
      const r = await devBackend(this.os, 'request', String(port), { req, origin: `http://localhost:${port}` }, { cwd: root, onStdout: (t) => this.#serverLog(port, 'log', t), onStderr: (t) => this.#serverLog(port, 'error', t) });
      this.os.procs.account(s.info.pid, performance.now() - started);
      // The window hosting the sandbox may have closed since the backend was loaded.
      if (r.error === 'backend not loaded') {
        s.backendReady = false;
        continue;
      }
      if (r.error) return fail(`${req.method} ${u.pathname}: ${r.error}`);
      const res = r.response;
      if (!res) {
        this.log(port, [{ level: 'warn', source: 'network', text: `${req.method} ${req.url} → 404 (no file, and the backend did not answer)` }]);
        return text(404, `Not found: ${u.pathname}`);
      }
      if (res.status >= 400) this.log(port, [{ level: res.status >= 500 ? 'error' : 'warn', source: 'network', text: `${req.method} ${req.url} → ${res.status}` }]);
      return res;
    }
    return fail('the backend could not be started');
  }
}
