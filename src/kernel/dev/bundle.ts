import type * as Esbuild from 'esbuild-wasm';
import { dirname, extname, isInside, join, normalize, resolve } from '@/kernel/vfs/path';
import { fetchModule, Npm, type PackageJson } from './npm';

/**
 * Bundling with esbuild (compiled to WebAssembly) over the virtual filesystem:
 * TypeScript, JSX, CSS (and CSS modules), JSON and assets from the project
 * folder; npm packages from esm.sh. One bundle per entry, no files written.
 */

export type EsbuildApi = Pick<typeof Esbuild, 'build'>;

let loader: (() => Promise<EsbuildApi>) | null = null;
let api: Promise<EsbuildApi> | null = null;

/** The kernel installs a loader that reads esbuild from the package cache; tests pass the npm build. */
export function setEsbuildLoader(fn: () => Promise<EsbuildApi>): void {
  loader = fn;
  api = null;
}

export function esbuild(): Promise<EsbuildApi> {
  if (!loader) return Promise.reject(new Error('esbuild is not available here'));
  api ??= loader().catch((err: unknown) => {
    api = null;
    throw err;
  });
  return api;
}

/** The bit of the filesystem a build reads. */
export interface BuildFs {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ kind: 'file' | 'dir' } | null>;
}

export interface BundleInput {
  fs: BuildFs;
  /** Imports may not leave this folder. */
  root: string;
  /** A file, or inline source (an HTML page's `<script type="module">`). */
  entry: string | { contents: string; dir: string; name: string };
  /** browser: the page's code · server: the backend, as a script that sets `__bbxServer`. */
  target: 'browser' | 'server';
  /** `import.meta.env` (browser) — VITE_ variables and the like. */
  env?: Record<string, string>;
  pkg?: PackageJson | null;
  tsconfig?: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]>; jsxImportSource?: string } } | null;
  fetcher?: typeof fetch;
}

export interface BundleOutput {
  js: string;
  css: string;
  errors: string[];
  warnings: string[];
  /** Project files the bundle read, for rebuilding when one changes. */
  inputs: string[];
}

const EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.css'];
const ASSET = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|webm|pdf)$/i;
const TEXT = /\.(txt|md|html|glsl|wgsl|vert|frag|csv)$/i;

function loaderFor(path: string, query: string): Esbuild.Loader {
  if (query === 'raw') return 'text';
  if (query === 'url' || query === 'inline') return 'dataurl';
  const ext = extname(path);
  if (path.endsWith('.module.css')) return 'local-css';
  if (ext === 'css') return 'css';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'ts';
  if (ext === 'tsx') return 'tsx';
  // .js may hold JSX in many projects; the JSX loader handles plain JavaScript too.
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'jsx';
  if (ext === 'json') return 'json';
  if (ext === 'wasm') return 'binary';
  if (TEXT.test(path)) return 'text';
  if (ASSET.test(path)) return 'dataurl';
  return 'text';
}

const fmt = (m: Esbuild.Message) => {
  const at = m.location ? `${m.location.file.replace(/^vfs:/, '')}:${m.location.line}:${m.location.column + 1}: ` : '';
  const line = m.location?.lineText ? `\n    ${m.location.lineText.trim()}` : '';
  return `${at}${m.text}${line}`;
};

export async function bundle(input: BundleInput): Promise<BundleOutput> {
  const { fs, root } = input;
  const npm = new Npm(input.pkg ?? null, input.target === 'browser');
  const fetcher = input.fetcher ?? fetch;
  const inputs = new Set<string>();
  const paths = input.tsconfig?.compilerOptions?.paths ?? {};
  const baseUrl = resolve(root, input.tsconfig?.compilerOptions?.baseUrl ?? '.');
  const deps = npm.versions;
  const jsxImportSource = input.tsconfig?.compilerOptions?.jsxImportSource ?? (deps.preact && !deps.react ? 'preact' : 'react');

  const isFile = async (p: string) => (await fs.stat(p).catch(() => null))?.kind === 'file';
  async function probe(p: string): Promise<string | null> {
    if (await isFile(p)) return p;
    for (const e of EXTS) if (await isFile(p + e)) return p + e;
    // TypeScript projects import './x.js' for './x.ts'.
    if (/\.jsx?$/.test(p)) for (const e of ['.ts', '.tsx']) if (await isFile(p.replace(/\.jsx?$/, e))) return p.replace(/\.jsx?$/, e);
    for (const e of EXTS) if (await isFile(`${p}/index${e}`)) return `${p}/index${e}`;
    return null;
  }
  function alias(spec: string): string[] {
    const out: string[] = [];
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf('*');
      if (star < 0 ? spec !== pattern : !(spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)))) continue;
      const mid = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
      for (const t of targets) out.push(resolve(baseUrl, t.replace('*', mid)));
    }
    // Vite's usual alias: '@/x' → src/x.
    if (!out.length && spec.startsWith('@/')) out.push(join(root, 'src', spec.slice(2)));
    return out;
  }

  const plugin: Esbuild.Plugin = {
    name: 'bbx',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        const [spec, query = ''] = args.path.split('?') as [string, string?];
        if (args.namespace === 'npm' || /^https?:\/\//.test(spec)) {
          const base = args.namespace === 'npm' ? args.importer : undefined;
          if (/^(https?:)?\/\/|^\.{0,2}\//.test(args.path)) return { path: npm.canonical(new URL(args.path, base).href), namespace: 'npm' };
          return { path: npm.url(args.path), namespace: 'npm' };
        }
        let candidates: string[];
        if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') candidates = [resolve(args.resolveDir || root, spec)];
        else if (spec.startsWith('/')) candidates = isInside(root, spec) && root !== '/' ? [normalize(spec)] : [join(root, spec)];
        else {
          candidates = alias(spec);
          if (!candidates.length) return { path: npm.url(args.path), namespace: 'npm' };
        }
        for (const c of candidates) {
          if (!isInside(root, c)) return { errors: [{ text: `${args.path} is outside the project folder (${root})` }] };
          const hit = await probe(c);
          if (hit) return { path: hit, namespace: 'vfs', pluginData: { query } };
        }
        return { errors: [{ text: `Could not find "${args.path}"${args.importer ? ` (imported by ${args.importer})` : ''}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: 'vfs' }, async (args) => {
        inputs.add(args.path);
        const bytes = await fs.readFile(args.path);
        const loader = loaderFor(args.path, (args.pluginData as { query?: string } | undefined)?.query ?? '');
        return { contents: bytes, loader, resolveDir: dirname(args.path) };
      });
      b.onLoad({ filter: /.*/, namespace: 'npm' }, async (args) => {
        const contents = await fetchModule(args.path, fetcher);
        return { contents, loader: /\.css(\?|$)/.test(new URL(args.path).pathname) ? 'css' : 'js' };
      });
    },
  };

  const env = { MODE: 'development', DEV: true, PROD: false, SSR: input.target === 'server', BASE_URL: '/', ...input.env };
  const entry = input.entry;
  try {
    const b = await esbuild();
    const res = await b.build({
      ...(typeof entry === 'string' ? { entryPoints: [entry] } : { stdin: { contents: entry.contents, resolveDir: entry.dir, sourcefile: entry.name, loader: 'tsx' } }),
      bundle: true,
      write: false,
      outdir: '/out',
      format: input.target === 'server' ? 'iife' : 'esm',
      globalName: input.target === 'server' ? '__bbxServer' : undefined,
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource,
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify(env) },
      logLevel: 'silent',
      charset: 'utf8',
      plugins: [plugin],
    });
    const out = (ext: string) => res.outputFiles?.find((f) => f.path.endsWith(ext))?.text ?? '';
    return { js: out('.js'), css: out('.css'), errors: [], warnings: res.warnings.map(fmt), inputs: [...inputs] };
  } catch (err) {
    const failure = err as Partial<Esbuild.BuildFailure>;
    const errors = failure.errors?.length ? failure.errors.map(fmt) : [(err as Error).message ?? String(err)];
    return { js: '', css: '', errors, warnings: (failure.warnings ?? []).map(fmt), inputs: [...inputs] };
  }
}

export async function dataUrl(bytes: Uint8Array, type: string): Promise<string> {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}
