import type { FsApi } from '../host/os.js';
import { globToRegExp, join } from '../host/path.js';

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.bbx', '.sessions', '.DS_Store']);
const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

/** Patterns from .gitignore (the common forms: names, dir/, *.ext, paths). */
function ignoreRules(text: string): Array<(rel: string, isDir: boolean) => boolean> {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((pattern) => {
      const dirOnly = pattern.endsWith('/');
      const p = pattern.replace(/\/$/, '').replace(/^\//, '');
      const re = globToRegExp(p.includes('/') ? p : `**/${p}`);
      const reRoot = globToRegExp(p);
      return (rel: string, isDir: boolean) => (!dirOnly || isDir) && (re.test('/' + rel) || reRoot.test(rel) || re.test(rel));
    });
}

/** A folder's files (path relative to it → bytes), leaving out .git, node_modules and what .gitignore lists. */
export async function collectFiles(fs: FsApi, root: string): Promise<Map<string, Uint8Array>> {
  const rules = ignoreRules(await fs.readText(join(root, '.gitignore')).catch(() => ''));
  const out = new Map<string, Uint8Array>();
  let bytes = 0;
  const walk = async (dir: string, rel: string) => {
    for (const s of await fs.readdir(dir).catch(() => [])) {
      const r = rel ? `${rel}/${s.name}` : s.name;
      if (ALWAYS_SKIP.has(s.name) || rules.some((ok) => ok(r, s.kind === 'dir'))) continue;
      if (s.kind === 'dir') await walk(s.path, r);
      else {
        if (out.size >= MAX_FILES) throw new Error(`more than ${MAX_FILES} files: add a .gitignore for build output and dependencies`);
        const data = await fs.readFile(s.path);
        bytes += data.length;
        if (bytes > MAX_BYTES) throw new Error('the folder is over 200 MB; leave large files out with .gitignore');
        out.set(r, data);
      }
    }
  };
  await walk(root, '');
  return out;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha1 = async (data: Uint8Array) => hex(await crypto.subtle.digest('SHA-1', data as Uint8Array<ArrayBuffer>));

/** Git's object id for file content: sha1("blob <size>\0" + content). */
export async function gitBlobSha(data: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  return sha1(all);
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromBase64 = (s: string) => Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0));

/** Runs `fn` over items, `n` at a time. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}
