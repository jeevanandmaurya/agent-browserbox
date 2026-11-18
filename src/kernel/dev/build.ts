import { basename, extname, join } from '@/kernel/vfs/path';
import type { FsApi } from '@/kernel/api';
import { bundle } from './bundle';
import { renderHtml } from './html';
import type { PackageJson } from './npm';

/** Files that are sources, config or tooling: built into pages, never copied as they are. */
const SOURCE = /\.(tsx?|jsx|mts|cts)$/;
const SKIP_NAMES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'AGENTS.md', 'CLAUDE.md', 'README.md']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.bbx']);
const MAX_FILES = 2000;

export interface BuildResult {
  /** Site path (/index.html) → bytes. */
  files: Map<string, Uint8Array>;
  errors: string[];
  /** The project has a server.ts backend, which a static host does not run. */
  backend: string | null;
}

/**
 * A production build of a project the dev server can serve: every HTML page
 * with its scripts and styles bundled, minified and inlined (npm packages
 * from esm.sh included), plus the project's other files (images, fonts,
 * JSON) as they are. The result is a static site any host can serve.
 */
export async function buildSite(fs: FsApi, root: string): Promise<BuildResult> {
  const files = new Map<string, Uint8Array>();
  const errors: string[] = [];
  const pkg = await fs.readText(join(root, 'package.json')).then((t) => JSON.parse(t) as PackageJson, () => null);
  const tsconfig = await fs.readText(join(root, 'tsconfig.json')).then((t) => JSON.parse(t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')), () => null);
  const env: Record<string, string> = {};
  for (const name of ['.env', '.env.production']) {
    const t = await fs.readText(join(root, name)).catch(() => '');
    for (const line of t.split('\n')) {
      const m = /^\s*((?:VITE_|PUBLIC_)\w+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const build = (entry: Parameters<typeof bundle>[0]['entry']) => bundle({ fs, root, entry, target: 'browser', production: true, env, pkg, tsconfig });

  const all: string[] = [];
  const walk = async (dir: string) => {
    for (const s of await fs.readdir(dir).catch(() => [])) {
      if (s.name.startsWith('.') || SKIP_DIRS.has(s.name)) continue;
      if (s.kind === 'dir') await walk(s.path);
      else if (all.length < MAX_FILES) all.push(s.path);
    }
  };
  await walk(root);
  const backend = ['server.ts', 'server.js', 'server.mjs'].find((f) => all.includes(join(root, f))) ?? null;
  const pages = all.filter((p) => /\.html?$/i.test(p));
  const render = async (htmlPath: string | null, out: string) => {
    const page = await renderHtml(fs, { root, htmlPath, path: '/', port: 0, runtime: false, bundle: build });
    errors.push(...page.errors);
    files.set(out, new TextEncoder().encode(page.html));
  };
  if (pages.length) for (const p of pages) await render(p, p.slice(root.length));
  else await render(null, '/index.html'); // a project with only src/main.tsx gets a page
  for (const p of all) {
    const name = basename(p);
    if (pages.includes(p) || SOURCE.test(p) || SKIP_NAMES.has(name) || name === backend || (extname(p) === 'css' && p.includes('/src/'))) continue;
    // Plain scripts and styles next to the pages are inlined already; other files are copied.
    files.set(p.slice(root.length), await fs.readFile(p));
  }
  return { files, errors, backend };
}
