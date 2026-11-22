import type { WebContainer } from '@webcontainer/api';
import type { Kernel } from '@/kernel/api';
import { isInside } from '@/kernel/vfs/path';

/**
 * Node.js in the browser, through WebContainers (StackBlitz's in-browser Node
 * runtime). It runs here, in a window, because it needs a document that is
 * cross-origin isolated. A project folder is copied in before a command runs,
 * kept in step while it runs (so dev servers see edits), and what the command
 * changed is copied back afterwards. node_modules stays inside.
 */

export interface NodeJob {
  /** The project folder (where package.json is). */
  root: string;
  /** Where the command runs. */
  cwd: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

const SKIP = new Set(['node_modules', '.git', '.sessions']);
let container: Promise<WebContainer> | null = null;
/** VFS path → "size:mtime" of what was last copied in, per file. */
const copied = new Map<string, string>();
let onServer: ((port: number, url: string) => void) | null = null;

async function boot(): Promise<WebContainer> {
  if (!globalThis.crossOriginIsolated) throw new Error('Node.js needs cross-origin isolation: turn it on in Settings → Environment, then reload BrowserBox.');
  const { WebContainer } = await import('@webcontainer/api');
  const wc = await WebContainer.boot({ coep: 'credentialless', workdirName: 'bbx' });
  wc.on('server-ready', (port, url) => onServer?.(port, url));
  return wc;
}

/** Each project gets its own folder inside the container. */
const slot = (root: string) => 'p' + [...root].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7).toString(36).replace('-', 'n');

async function copyIn(os: Kernel, wc: WebContainer, root: string, dir: string): Promise<void> {
  const seen = new Set<string>();
  const walk = async (path: string) => {
    for (const s of await os.fs.readdir(path).catch(() => [])) {
      if (SKIP.has(s.name)) continue;
      if (s.kind === 'dir') {
        await walk(s.path);
        continue;
      }
      seen.add(s.path);
      const stamp = `${s.size}:${s.mtime}`;
      if (copied.get(s.path) === stamp) continue;
      const rel = s.path.slice(root.length);
      await wc.fs.mkdir(`${dir}${rel.slice(0, rel.lastIndexOf('/'))}`, { recursive: true });
      await wc.fs.writeFile(`${dir}${rel}`, await os.fs.readFile(s.path));
      copied.set(s.path, stamp);
    }
  };
  await walk(root);
  // Removed in BrowserBox since the last run: remove inside too.
  for (const p of [...copied.keys()]) {
    if (isInside(root, p) && !seen.has(p)) {
      await wc.fs.rm(`${dir}${p.slice(root.length)}`, { force: true }).catch(() => undefined);
      copied.delete(p);
    }
  }
}

async function copyOut(os: Kernel, wc: WebContainer, root: string, dir: string): Promise<number> {
  let n = 0;
  const present = new Set<string>();
  const walk = async (rel: string) => {
    for (const e of await wc.fs.readdir(`${dir}${rel}`, { withFileTypes: true }).catch(() => [])) {
      if (SKIP.has(e.name)) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        await walk(r);
        continue;
      }
      const path = root + r;
      present.add(path);
      const data = await wc.fs.readFile(`${dir}${r}`);
      const mine = await os.fs.readFile(path).catch(() => null);
      if (!mine || mine.length !== data.length || mine.some((b, i) => b !== data[i])) {
        await os.fs.writeFile(path, data);
        n++;
      }
      const st = await os.fs.stat(path);
      if (st) copied.set(path, `${st.size}:${st.mtime}`);
    }
  };
  await walk('');
  // Deleted by the command (e.g. rm in a script): delete here too, but only files that were copied in.
  for (const p of [...copied.keys()]) {
    if (isInside(root, p) && !present.has(p)) {
      await os.fs.rm(p).catch(() => undefined);
      copied.delete(p);
      n++;
    }
  }
  return n;
}

export async function runNode(os: Kernel, job: NodeJob, io: { out(text: string): void; signal: AbortSignal }): Promise<{ code: number }> {
  io.out('\x1b[2mstarting Node.js (WebContainers)…\x1b[0m\r');
  const wc = await (container ??= boot().catch((err: unknown) => {
    container = null;
    throw err;
  }));
  const dir = slot(job.root);
  const cwd = `${dir}${job.cwd.slice(job.root.length)}`;
  await wc.fs.mkdir(cwd, { recursive: true });
  await copyIn(os, wc, job.root, dir);
  io.out('\x1b[2K\r');
  // While the command runs (a dev server can run for hours), edits made in BrowserBox follow it in.
  let pending = 0;
  const off = os.bus.on('fs:change', ({ path }) => {
    if (!isInside(job.root, path) || path.split('/').some((p) => SKIP.has(p))) return;
    clearTimeout(pending);
    pending = window.setTimeout(() => void copyIn(os, wc, job.root, dir), 150);
  });
  onServer = (port, url) => {
    io.out(`\n  \x1b[32m➜\x1b[0m  ${url}  \x1b[2m(port ${port}; opened in Browser)\x1b[0m\n\n`);
    os.openApp('browser', { url });
  };
  try {
    const proc = await wc.spawn(job.cmd, job.args, { cwd, env: job.env });
    const done = proc.output.pipeTo(new WritableStream({ write: (chunk) => io.out(chunk) })).catch(() => undefined);
    const kill = () => proc.kill();
    io.signal.addEventListener('abort', kill);
    const code = await proc.exit;
    io.signal.removeEventListener('abort', kill);
    await done;
    return { code };
  } finally {
    off();
    clearTimeout(pending);
    const n = await copyOut(os, wc, job.root, dir).catch(() => 0);
    if (n) io.out(`\x1b[2m${n} file${n === 1 ? '' : 's'} updated in ${job.root}\x1b[0m\n`);
  }
}
