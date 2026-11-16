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
  const fn = new AsyncFunction('fs', 'console', 'print', 'args', m.code);
  const value = await fn(fs, console, line(out), m.args ?? []);
  return { value: value === undefined ? undefined : show(value) };
}

// ---- Python (Pyodide, CPython compiled to WebAssembly) ---------------------
async function runPython(m, out, err) {
  if (!pyodide) {
    out('[python] loading Pyodide runtime…\n');
    importScripts(m.pyodideUrl + 'pyodide.js');
    pyodide = await loadPyodide({ indexURL: m.pyodideUrl });
    pyodide.FS.mkdirTree('/work');
  }
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
