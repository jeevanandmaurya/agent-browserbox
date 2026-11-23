// BrowserBox sandbox runtime. This file is shipped as text and started as a
// Worker inside an opaque-origin iframe, so it must stay dependency-free JS.
/* eslint-disable */
let port;
let nextRpc = 1;
const pending = new Map();
let pyodide = null;

self.onmessage = (e) => {
  if (e.data?.type !== 'port') return;
  port = e.ports[0];
  port.onmessage = (ev) => handle(ev.data);
  port.postMessage({ type: 'ready' });
};

function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const rid = nextRpc++;
    pending.set(rid, { resolve, reject });
    port.postMessage({ id, type: 'rpc', rid, method, params });
  });
}

function show(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || String(v);
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x), 2) ?? String(v);
  } catch {
    return String(v);
  }
}

async function handle(m) {
  if (m.type === 'rpc-result') {
    const p = pending.get(m.rid);
    pending.delete(m.rid);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
    return;
  }
  const out = (data) => port.postMessage({ id: m.id, type: 'stdout', data });
  const err = (data) => port.postMessage({ id: m.id, type: 'stderr', data });
  try {
    let result;
    if (m.op === 'js') result = await runJs(m, out, err);
    else if (m.op === 'python') result = await runPython(m, out, err);
    else if (m.op === 'wasm') result = await runWasi(m, out, err);
    else if (m.op === 'server-load') result = await serverLoad(m);
    else if (m.op === 'server-request') result = await serverRequest(m);
    else throw new Error('unknown op ' + m.op);
    port.postMessage({ id: m.id, type: 'done', result });
  } catch (e) {
    port.postMessage({ id: m.id, type: 'done', error: e?.stack ? String(e.stack) : String(e) });
  }
}

// ---- JavaScript -----------------------------------------------------------
async function runJs(m, out, err) {
  const line = (sink) => (...a) => sink(a.map(show).join(' ') + '\n');
  const console = { log: line(out), info: line(out), debug: line(out), warn: line(err), error: line(err), table: line(out) };
  const call = (method) => (...params) => rpc(m.id, method, params);
  const fs = {
    readText: call('fs.readText'),
    readFile: call('fs.readFile'),
    writeFile: call('fs.writeFile'),
    appendFile: call('fs.appendFile'),
    readdir: call('fs.readdir'),
    exists: call('fs.exists'),
    mkdir: call('fs.mkdir'),
    rm: call('fs.rm'),
    glob: call('fs.glob'),
  };
  const AsyncFunction = (async () => {}).constructor;
  const fn = new AsyncFunction('fs', 'console', 'print', 'args', 'env', m.code);
  const value = await fn(fs, console, line(out), m.args ?? [], Object.freeze({ ...(m.env ?? {}) }));
  return { value: value === undefined ? undefined : show(value) };
}

// ---- Dev-server backend -----------------------------------------------------
// The project's server.ts, bundled as a script that sets __bbxServer. It stays
// loaded; each request is a job. Its console and fs go to whichever request is
// running (the kernel sends one at a time).
let backend = null;
let currentJob = 0;

async function serverLoad(m) {
  currentJob = m.id;
  const line = (type) => (...a) => port.postMessage({ id: currentJob, type, data: a.map(show).join(' ') + '\n' });
  const console = { log: line('stdout'), info: line('stdout'), debug: line('stdout'), warn: line('stderr'), error: line('stderr'), table: line('stdout') };
  const call = (method) => (...params) => rpc(currentJob, method, params);
  const fs = {
    readText: call('fs.readText'), readFile: call('fs.readFile'), writeFile: call('fs.writeFile'), appendFile: call('fs.appendFile'),
    readdir: call('fs.readdir'), exists: call('fs.exists'), mkdir: call('fs.mkdir'), rm: call('fs.rm'), glob: call('fs.glob'),
  };
  const env = Object.freeze({ ...(m.env ?? {}), fs });
  const mod = new Function('console', 'fs', 'env', m.code + '\n;return typeof __bbxServer === "undefined" ? undefined : __bbxServer;')(console, fs, env);
  const h = mod && (mod.default ?? mod);
  const handler = typeof h === 'function' ? h : h && typeof h.fetch === 'function' ? (req, e) => h.fetch(req, e) : null;
  if (!handler) throw new Error('the backend must export default a function (request) => Response, or an object with fetch(request)');
  backend = { handler, env };
  return { value: 'loaded' };
}

async function serverRequest(m) {
  if (!backend) throw new Error('backend not loaded');
  currentJob = m.id;
  const r = m.req;
  const init = { method: r.method, headers: r.headers };
  if (r.body && !/^(GET|HEAD)$/i.test(r.method)) init.body = r.body;
  const res = await backend.handler(new Request(m.origin + r.url, init), backend.env);
  if (res == null) return { response: null };
  if (!(res instanceof Response)) throw new Error('the backend returned ' + show(res) + ' instead of a Response');
  const headers = [];
  res.headers.forEach((v, k) => headers.push([k, v]));
  const buf = await res.arrayBuffer();
  return { response: { status: res.status, statusText: res.statusText, headers, body: new Uint8Array(buf) } };
}

// ---- Python (Pyodide, CPython compiled to WebAssembly) ---------------------
async function runPython(m, out, err) {
  if (!pyodide) {
    const base = m.pyodideUrl;
    const progress = (label, loaded, total) => port.postMessage({ id: m.id, type: 'progress', label, loaded, total });
    const have = new Map((m.runtime ?? []).map((f) => [base + f.path, f.data]));
    if (!have.size) {
      // Not installed as a pack: fetch the big file ourselves so the download is visible.
      out('[python] downloading the Python runtime…\n');
      const res = await fetch(base + 'pyodide.asm.wasm');
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = [];
      let loaded = 0;
      for (const reader = res.body.getReader(); ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        progress('Python runtime', loaded, total);
      }
      have.set(base + 'pyodide.asm.wasm', new Uint8Array(await new Blob(chunks).arrayBuffer()));
    }
    // Serve the runtime's own files from memory instead of the network.
    const realFetch = self.fetch.bind(self);
    self.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const data = have.get(url);
      if (!data) return realFetch(input, init);
      const type = url.endsWith('.wasm') ? 'application/wasm' : url.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      return Promise.resolve(new Response(data, { headers: { 'content-type': type } }));
    };
    const realImport = self.importScripts.bind(self);
    self.importScripts = (...urls) => {
      for (const url of urls) {
        const data = have.get(url);
        if (data) (0, eval)(new TextDecoder().decode(data));
        else realImport(url);
      }
    };
    importScripts(base + 'pyodide.js');
    pyodide = await loadPyodide({ indexURL: base });
    pyodide.FS.mkdirTree('/work');
  }
  if (m.env) pyodide.runPython('import os\nos.environ.update(' + JSON.stringify(m.env) + ')');
  pyodide.setStdout({ batched: (s) => out(s + '\n') });
  pyodide.setStderr({ batched: (s) => err(s + '\n') });
  const FS = pyodide.FS;
  const before = new Map();
  for (const f of m.files ?? []) {
    const p = '/work/' + f.path;
    FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
    FS.writeFile(p, f.data);
    before.set(f.path, FS.stat(p).mtime.getTime?.() ?? FS.stat(p).mtime);
  }
  FS.chdir('/work');
  if (m.packages?.length) {
    await pyodide.loadPackage('micropip');
    await pyodide.pyimport('micropip').install(m.packages);
  }
  await pyodide.loadPackagesFromImports(m.code);
  const value = await pyodide.runPythonAsync(m.code);
  // Collect files the program created or modified under /work.
  const changed = [];
  const walk = (dir, rel) => {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const p = dir + '/' + name;
      const r = rel ? rel + '/' + name : name;
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) walk(p, r);
      else {
        const mt = st.mtime.getTime?.() ?? st.mtime;
        if (before.get(r) !== mt && st.size <= 32 * 1024 * 1024) changed.push({ path: r, data: FS.readFile(p) });
      }
    }
  };
  walk('/work', '');
  for (const f of m.files ?? []) before.delete(f.path);
  let shown;
  if (value !== undefined && value !== null) {
    shown = typeof value?.toString === 'function' ? value.toString() : show(value);
    value?.destroy?.();
  }
  return { value: shown, files: changed };
}

// ---- WASI preview1 (enough for stdio programs) ----------------------------
async function runWasi(m, out, err) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const args = [m.name ?? 'program', ...(m.args ?? [])].map((a) => enc.encode(a + '\0'));
  const stdin = enc.encode(m.stdin ?? '');
  let stdinPos = 0;
  let memory;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  class Exit extends Error {
    constructor(code) {
      super('exit ' + code);
      this.code = code;
    }
  }
  const ESUCCESS = 0, EBADF = 8, ENOSYS = 52;
  const wasi = {
    args_sizes_get(argc, bufSize) {
      view().setUint32(argc, args.length, true);
      view().setUint32(bufSize, args.reduce((n, a) => n + a.length, 0), true);
      return ESUCCESS;
    },
    args_get(argv, buf) {
      for (const a of args) {
        view().setUint32(argv, buf, true);
        bytes().set(a, buf);
        argv += 4;
        buf += a.length;
      }
      return ESUCCESS;
    },
    environ_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return ESUCCESS;
    },
    environ_get: () => ESUCCESS,
    clock_res_get(_id, res) {
      view().setBigUint64(res, 1000000n, true);
      return ESUCCESS;
    },
    clock_time_get(id, _prec, time) {
      const ms = id === 0 ? Date.now() : performance.now();
      view().setBigUint64(time, BigInt(Math.round(ms * 1e6)), true);
      return ESUCCESS;
    },
    random_get(buf, len) {
      for (let off = 0; off < len; off += 65536) crypto.getRandomValues(new Uint8Array(memory.buffer, buf + off, Math.min(65536, len - off)));
      return ESUCCESS;
    },
    fd_write(fd, iovs, iovsLen, nwritten) {
      if (fd !== 1 && fd !== 2) return EBADF;
      let total = 0;
      let text = '';
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        text += dec.decode(bytes().subarray(ptr, ptr + len), { stream: true });
        total += len;
      }
      (fd === 1 ? out : err)(text);
      view().setUint32(nwritten, total, true);
      return ESUCCESS;
    },
    fd_read(fd, iovs, iovsLen, nread) {
      if (fd !== 0) return EBADF;
      let total = 0;
      for (let i = 0; i < iovsLen && stdinPos < stdin.length; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        const chunk = stdin.subarray(stdinPos, stdinPos + len);
        bytes().set(chunk, ptr);
        stdinPos += chunk.length;
        total += chunk.length;
      }
      view().setUint32(nread, total, true);
      return ESUCCESS;
    },
    fd_fdstat_get(fd, stat) {
      if (fd > 2) return EBADF;
      view().setUint8(stat, 2); // character device
      view().setUint16(stat + 2, 0, true);
      view().setBigUint64(stat + 8, 0xffffffffn, true);
      view().setBigUint64(stat + 16, 0n, true);
      return ESUCCESS;
    },
    fd_close: () => ESUCCESS,
    fd_seek: () => 70, // ESPIPE
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    proc_exit(code) {
      throw new Exit(code);
    },
    sched_yield: () => ESUCCESS,
    poll_oneoff: () => ENOSYS,
  };
  const module = await WebAssembly.compile(m.wasm);
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') continue;
    (imports[imp.module] ??= {})[imp.name] =
      imp.module === 'wasi_snapshot_preview1' && wasi[imp.name] ? wasi[imp.name] : () => ENOSYS;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory;
  let exitCode = 0;
  try {
    if (typeof instance.exports._start === 'function') instance.exports._start();
    else if (typeof instance.exports.main === 'function') exitCode = instance.exports.main() | 0;
    else throw new Error('module exports neither _start nor main; exports: ' + Object.keys(instance.exports).join(', '));
  } catch (e) {
    if (e instanceof Exit) exitCode = e.code;
    else throw e;
  }
  return { exitCode };
}
