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
/** Thrown to end a program with an exit code (WASI proc_exit, JavaScript exit()). */
class Exit extends Error {
  constructor(code) {
    super('exit ' + code);
    this.code = code;
  }
}

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
  // exit(code) ends the program with that exit code (as process.exit does).
  const exit = (code = 0) => {
    throw new Exit(Number(code) | 0);
  };
  const fn = new AsyncFunction('fs', 'console', 'print', 'args', 'env', 'exit', 'stdin', m.code);
  try {
    const value = await fn(fs, console, line(out), m.args ?? [], Object.freeze({ ...(m.env ?? {}) }), exit, m.stdin ?? '');
    return { value: value === undefined ? undefined : show(value) };
  } catch (e) {
    if (e instanceof Exit) return { exitCode: e.code };
    throw e;
  }
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

// ---- WASI preview1: stdio, and the working folder's files -----------------------
// The box's files live in the kernel, behind asynchronous messages, but WASI calls are
// synchronous. So, as for Python, the working folder is copied in before the run
// (m.files, relative to m.cwd), the program works on that copy, and what it changed,
// created or deleted is reported back and written to the box when it exits.
async function runWasi(m, out, err) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const args = [m.name ?? 'program', ...(m.args ?? [])].map((a) => enc.encode(a + '\0'));
  const env = Object.entries(m.env ?? {}).map(([k, v]) => enc.encode(`${k}=${v}\0`));
  const stdin = enc.encode(m.stdin ?? '');
  let stdinPos = 0;
  let memory;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const ESUCCESS = 0, EBADF = 8, EEXIST = 20, EINVAL = 28, EISDIR = 31, ENOENT = 44, ENOSYS = 52, ENOTDIR = 54, ENOTEMPTY = 55, ESPIPE = 70, ENOTCAPABLE = 76;
  const DIR = 3, FILE = 4, CHAR = 2;

  // ---- the in-memory folder: '' is the working folder; paths have no leading slash
  const files = new Map(); // path -> { data: Uint8Array, mtime }
  const dirs = new Set(['']);
  const changed = new Set();
  const deleted = new Set();
  const made = new Set();
  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const addDirs = (p) => {
    for (let d = parentOf(p); d && !dirs.has(d); d = parentOf(d)) dirs.add(d);
  };
  for (const f of m.files ?? []) {
    files.set(f.path, { data: f.data, mtime: Date.now() });
    addDirs(f.path);
  }
  const now = () => BigInt(Date.now()) * 1000000n;
  const inode = (p) => {
    let h = 2166136261;
    for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p.charCodeAt(i), 16777619);
    return BigInt(h >>> 0) + 1n;
  };

  // ---- descriptors: 0-2 stdio; 3 '.' and 4 the working folder's absolute path (both the same folder)
  const cwdName = m.cwd || '/';
  const fds = new Map([
    [3, { kind: 'dir', path: '', preopen: '.' }],
    [4, { kind: 'dir', path: '', preopen: cwdName }],
  ]);
  let nextFd = 5;
  const readStr = (ptr, len) => dec.decode(bytes().subarray(ptr, ptr + len));
  /** A path relative to a directory descriptor, normalised; null if it leaves the folder. */
  const resolveAt = (dirfd, path) => {
    const base = fds.get(dirfd);
    if (!base || base.kind !== 'dir') return null;
    let rel = path;
    if (rel.startsWith('/')) {
      // An absolute path inside the working folder is fine; anything else is out of reach.
      if (cwdName !== '/' && (rel === cwdName || rel.startsWith(cwdName + '/'))) rel = rel.slice(cwdName.length);
      else if (cwdName !== '/') return null;
    }
    const parts = (base.path ? base.path.split('/') : []).concat(rel.split('/'));
    const outp = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!outp.length) return null;
        outp.pop();
      } else outp.push(part);
    }
    return outp.join('/');
  };
  const kindOf = (p) => (dirs.has(p) ? DIR : files.has(p) ? FILE : 0);
  const writeStat = (buf, p, kind) => {
    const v = view();
    v.setBigUint64(buf, 1n, true);
    v.setBigUint64(buf + 8, inode(p), true);
    v.setUint8(buf + 16, kind);
    v.setBigUint64(buf + 24, 1n, true);
    v.setBigUint64(buf + 32, BigInt(kind === FILE ? files.get(p).data.length : 0), true);
    const t = kind === FILE ? BigInt(files.get(p).mtime) * 1000000n : now();
    v.setBigUint64(buf + 40, t, true);
    v.setBigUint64(buf + 48, t, true);
    v.setBigUint64(buf + 56, t, true);
  };
  const touch = (p) => {
    changed.add(p);
    deleted.delete(p);
  };
  const iov = (iovs, i) => [view().getUint32(iovs + i * 8, true), view().getUint32(iovs + i * 8 + 4, true)];

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
      view().setUint32(count, env.length, true);
      view().setUint32(size, env.reduce((n, a) => n + a.length, 0), true);
      return ESUCCESS;
    },
    environ_get(environ, buf) {
      for (const e of env) {
        view().setUint32(environ, buf, true);
        bytes().set(e, buf);
        environ += 4;
        buf += e.length;
      }
      return ESUCCESS;
    },
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
      let total = 0;
      if (fd === 1 || fd === 2) {
        let text = '';
        for (let i = 0; i < iovsLen; i++) {
          const [ptr, len] = iov(iovs, i);
          text += dec.decode(bytes().subarray(ptr, ptr + len), { stream: true });
          total += len;
        }
        (fd === 1 ? out : err)(text);
      } else {
        const f = fds.get(fd);
        if (!f || f.kind !== 'file') return EBADF;
        const file = files.get(f.path);
        if (!file) return EBADF;
        if (f.append) f.pos = file.data.length;
        for (let i = 0; i < iovsLen; i++) {
          const [ptr, len] = iov(iovs, i);
          const end = f.pos + len;
          if (end > file.data.length) {
            const grown = new Uint8Array(Math.max(end, file.data.length * 2));
            grown.set(file.data);
            file.data = grown.subarray(0, end);
          }
          file.data.set(bytes().subarray(ptr, ptr + len), f.pos);
          f.pos = end;
          total += len;
        }
        file.mtime = Date.now();
        touch(f.path);
      }
      view().setUint32(nwritten, total, true);
      return ESUCCESS;
    },
    fd_read(fd, iovs, iovsLen, nread) {
      let total = 0;
      if (fd === 0) {
        for (let i = 0; i < iovsLen && stdinPos < stdin.length; i++) {
          const [ptr, len] = iov(iovs, i);
          const chunk = stdin.subarray(stdinPos, stdinPos + len);
          bytes().set(chunk, ptr);
          stdinPos += chunk.length;
          total += chunk.length;
        }
      } else {
        const f = fds.get(fd);
        if (!f) return EBADF;
        if (f.kind !== 'file') return EISDIR;
        const data = files.get(f.path)?.data ?? new Uint8Array();
        for (let i = 0; i < iovsLen && f.pos < data.length; i++) {
          const [ptr, len] = iov(iovs, i);
          const chunk = data.subarray(f.pos, f.pos + len);
          bytes().set(chunk, ptr);
          f.pos += chunk.length;
          total += chunk.length;
        }
      }
      view().setUint32(nread, total, true);
      return ESUCCESS;
    },
    fd_pread(fd, iovs, iovsLen, offset, nread) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'file') return EBADF;
      const pos = f.pos;
      f.pos = Number(offset);
      const r = wasi.fd_read(fd, iovs, iovsLen, nread);
      f.pos = pos;
      return r;
    },
    fd_pwrite(fd, iovs, iovsLen, offset, nwritten) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'file') return EBADF;
      const pos = f.pos;
      const append = f.append;
      f.pos = Number(offset);
      f.append = false;
      const r = wasi.fd_write(fd, iovs, iovsLen, nwritten);
      f.pos = pos;
      f.append = append;
      return r;
    },
    fd_fdstat_get(fd, stat) {
      const f = fds.get(fd);
      if (fd > 2 && !f) return EBADF;
      view().setUint8(stat, fd <= 2 ? CHAR : f.kind === 'dir' ? DIR : FILE);
      view().setUint16(stat + 2, f?.append ? 1 : 0, true);
      view().setBigUint64(stat + 8, 0xffffffffffffffffn, true);
      view().setBigUint64(stat + 16, 0xffffffffffffffffn, true);
      return ESUCCESS;
    },
    fd_fdstat_set_flags: () => ESUCCESS,
    fd_filestat_get(fd, buf) {
      const f = fds.get(fd);
      if (fd <= 2) {
        new Uint8Array(memory.buffer, buf, 64).fill(0);
        view().setUint8(buf + 16, CHAR);
        return ESUCCESS;
      }
      if (!f) return EBADF;
      const kind = kindOf(f.path);
      if (!kind) return ENOENT;
      writeStat(buf, f.path, kind);
      return ESUCCESS;
    },
    fd_filestat_set_size(fd, size) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'file') return EBADF;
      const file = files.get(f.path);
      const n = Number(size);
      const next = new Uint8Array(n);
      next.set(file.data.subarray(0, Math.min(n, file.data.length)));
      file.data = next;
      touch(f.path);
      return ESUCCESS;
    },
    fd_filestat_set_times: () => ESUCCESS,
    path_filestat_set_times: () => ESUCCESS,
    fd_advise: () => ESUCCESS,
    fd_allocate: () => ESUCCESS,
    fd_sync: () => ESUCCESS,
    fd_datasync: () => ESUCCESS,
    fd_close(fd) {
      if (fd > 4) fds.delete(fd);
      return ESUCCESS;
    },
    fd_seek(fd, offset, whence, newOffset) {
      const f = fds.get(fd);
      if (fd <= 2) return ESPIPE;
      if (!f || f.kind !== 'file') return EBADF;
      const size = files.get(f.path)?.data.length ?? 0;
      const base = whence === 0 ? 0 : whence === 1 ? f.pos : size;
      const next = base + Number(offset);
      if (next < 0) return EINVAL;
      f.pos = next;
      view().setBigUint64(newOffset, BigInt(next), true);
      return ESUCCESS;
    },
    fd_tell(fd, offset) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'file') return EBADF;
      view().setBigUint64(offset, BigInt(f.pos), true);
      return ESUCCESS;
    },
    fd_prestat_get(fd, buf) {
      const f = fds.get(fd);
      if (!f?.preopen) return EBADF;
      view().setUint8(buf, 0);
      view().setUint32(buf + 4, enc.encode(f.preopen).length, true);
      return ESUCCESS;
    },
    fd_prestat_dir_name(fd, path, len) {
      const f = fds.get(fd);
      if (!f?.preopen) return EBADF;
      bytes().set(enc.encode(f.preopen).subarray(0, len), path);
      return ESUCCESS;
    },
    fd_readdir(fd, buf, bufLen, cookie, bufUsed) {
      const f = fds.get(fd);
      if (!f || f.kind !== 'dir') return EBADF;
      const prefix = f.path ? f.path + '/' : '';
      const names = new Map([['.', DIR], ['..', DIR]]);
      for (const d of dirs) if (d !== f.path && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) names.set(d.slice(prefix.length), DIR);
      for (const p of files.keys()) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) names.set(p.slice(prefix.length), FILE);
      const list = [...names];
      let used = 0;
      for (let i = Number(cookie); i < list.length; i++) {
        const [name, type] = list[i];
        const nameBytes = enc.encode(name);
        const head = new Uint8Array(24);
        const hv = new DataView(head.buffer);
        hv.setBigUint64(0, BigInt(i + 1), true);
        hv.setBigUint64(8, inode(prefix + name), true);
        hv.setUint32(16, nameBytes.length, true);
        hv.setUint8(20, type);
        const entry = new Uint8Array(24 + nameBytes.length);
        entry.set(head);
        entry.set(nameBytes, 24);
        const room = bufLen - used;
        bytes().set(entry.subarray(0, Math.min(room, entry.length)), buf + used);
        used += Math.min(room, entry.length);
        if (used >= bufLen) break;
      }
      view().setUint32(bufUsed, used, true);
      return ESUCCESS;
    },
    path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, _rightsBase, _rightsInherit, fdflags, fdOut) {
      const p = resolveAt(dirfd, readStr(pathPtr, pathLen));
      if (p === null) return ENOTCAPABLE;
      const CREAT = 1, DIRECTORY = 2, EXCL = 4, TRUNC = 8, APPEND = 1;
      let kind = kindOf(p);
      if (kind && oflags & EXCL && oflags & CREAT) return EEXIST;
      if (!kind) {
        if (!(oflags & CREAT) || oflags & DIRECTORY) return ENOENT;
        if (!dirs.has(parentOf(p))) return ENOENT;
        files.set(p, { data: new Uint8Array(), mtime: Date.now() });
        touch(p);
        kind = FILE;
      }
      if (oflags & DIRECTORY && kind !== DIR) return ENOTDIR;
      if (kind === FILE && oflags & TRUNC) {
        files.get(p).data = new Uint8Array();
        touch(p);
      }
      const fd = nextFd++;
      fds.set(fd, { kind: kind === DIR ? 'dir' : 'file', path: p, pos: 0, append: !!(fdflags & APPEND) });
      view().setUint32(fdOut, fd, true);
      return ESUCCESS;
    },
    path_filestat_get(dirfd, _flags, pathPtr, pathLen, buf) {
      const p = resolveAt(dirfd, readStr(pathPtr, pathLen));
      if (p === null) return ENOTCAPABLE;
      const kind = kindOf(p);
      if (!kind) return ENOENT;
      writeStat(buf, p, kind);
      return ESUCCESS;
    },
    path_create_directory(dirfd, pathPtr, pathLen) {
      const p = resolveAt(dirfd, readStr(pathPtr, pathLen));
      if (p === null) return ENOTCAPABLE;
      if (kindOf(p)) return EEXIST;
      if (!dirs.has(parentOf(p))) return ENOENT;
      dirs.add(p);
      made.add(p);
      deleted.delete(p);
      return ESUCCESS;
    },
    path_remove_directory(dirfd, pathPtr, pathLen) {
      const p = resolveAt(dirfd, readStr(pathPtr, pathLen));
      if (p === null || p === '') return ENOTCAPABLE;
      if (!dirs.has(p)) return files.has(p) ? ENOTDIR : ENOENT;
      const prefix = p + '/';
      if ([...dirs].some((d) => d.startsWith(prefix)) || [...files.keys()].some((f) => f.startsWith(prefix))) return ENOTEMPTY;
      dirs.delete(p);
      made.delete(p);
      deleted.add(p);
      return ESUCCESS;
    },
    path_unlink_file(dirfd, pathPtr, pathLen) {
      const p = resolveAt(dirfd, readStr(pathPtr, pathLen));
      if (p === null) return ENOTCAPABLE;
      if (dirs.has(p)) return EISDIR;
      if (!files.delete(p)) return ENOENT;
      changed.delete(p);
      deleted.add(p);
      return ESUCCESS;
    },
    path_rename(fd, oldPtr, oldLen, newFd, newPtr, newLen) {
      const from = resolveAt(fd, readStr(oldPtr, oldLen));
      const to = resolveAt(newFd, readStr(newPtr, newLen));
      if (from === null || to === null) return ENOTCAPABLE;
      if (files.has(from)) {
        if (dirs.has(to)) return EISDIR;
        if (!dirs.has(parentOf(to))) return ENOENT;
        files.set(to, files.get(from));
        files.delete(from);
        changed.delete(from);
        deleted.add(from);
        touch(to);
        return ESUCCESS;
      }
      if (!dirs.has(from)) return ENOENT;
      // A folder: move everything under it.
      for (const d of [...dirs]) if (d === from || d.startsWith(from + '/')) {
        dirs.delete(d);
        deleted.add(d);
        const nd = to + d.slice(from.length);
        dirs.add(nd);
        made.add(nd);
        deleted.delete(nd);
      }
      for (const p of [...files.keys()]) if (p.startsWith(from + '/')) {
        const np = to + p.slice(from.length);
        files.set(np, files.get(p));
        files.delete(p);
        changed.delete(p);
        touch(np);
      }
      return ESUCCESS;
    },
    path_readlink: () => EINVAL,
    path_symlink: () => ENOSYS,
    path_link: () => ENOSYS,
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
  // What changed, for the kernel to write back (deletions first, then folders, then files).
  return {
    exitCode,
    files: [...changed].filter((p) => files.has(p)).map((p) => ({ path: p, data: files.get(p).data.slice() })),
    dirs: [...made].filter((d) => dirs.has(d)),
    deleted: [...deleted].filter((p) => !files.has(p) && !dirs.has(p)),
  };
}
