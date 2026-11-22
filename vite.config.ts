import { defineConfig } from 'vitest/config';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The kernel boots through a chain: page → bridge frame → bridge script → worker
 * script. On a slow connection each link is a round trip, so the built pages
 * list the whole chain up front and the browser downloads it in parallel.
 * Runs after the bundle is written because that is when file names are final.
 */
const kernelChain = () => ({
  name: 'bbx-kernel-chain',
  transformIndexHtml: (html: string) => (process.env.VITE_KERNEL_URL ? html.replace('src="../kernel/bridge.html"', `src="${new URL('bridge.html', process.env.VITE_KERNEL_URL).href}"`) : html),
  writeBundle(options: { dir?: string }) {
    const dir = options.dir ?? 'dist';
    const base = process.env.VITE_KERNEL_URL ? new URL('../', process.env.VITE_KERNEL_URL).href : '../';
    const bridge = readFileSync(`${dir}/kernel/bridge.html`, 'utf8');
    const files = new Set([...bridge.matchAll(/(?:src|href)="\.\.\/(assets\/[\w.-]+\.js)"/g)].map((m) => m[1]!));
    for (const f of readdirSync(`${dir}/assets`)) if (/^main-[\w-]+\.js$/.test(f)) files.add(`assets/${f}`); // the kernel worker
    const links = [...files].map((f) => `    <link rel="modulepreload" href="${base}${f}" />`).join('\n');
    writeFileSync(`${dir}/kernel/packages.json`, JSON.stringify(packageFiles(dir)));
    for (const page of ['agent/index.html', 'os/index.html', 'embed/index.html']) {
      const path = `${dir}/${page}`;
      if (!existsSync(path)) continue; // the runtime build has only embed/
      writeFileSync(path, readFileSync(path, 'utf8').replace('  </head>', `${links}\n  </head>`));
    }
  },
});

/**
 * Which build files belong to each package, with their sizes, so installs can
 * download exactly those and show real progress. A package's files are its
 * chunk (pkg-<id>-*.js) plus everything it references that the kernel itself
 * does not already load.
 */
function packageFiles(dir: string): Record<string, Array<{ url: string; bytes: number }>> {
  const assets = readdirSync(`${dir}/assets`);
  const text = new Map(assets.filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(`${dir}/assets/${f}`, 'utf8')]));
  const refs = (file: string, all: boolean) => {
    const src = text.get(file) ?? '';
    if (!all) return [...src.matchAll(/(?:import|from)\s*["']\.\/([\w.-]+\.js)["']/g)].map((m) => m[1]!);
    return assets.filter((f) => f !== file && src.includes(f));
  };
  const closure = (start: string[], all: boolean, stop = new Set<string>()) => {
    const seen = new Set<string>();
    const todo = [...start];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f) || stop.has(f)) continue;
      seen.add(f);
      todo.push(...refs(f, all));
    }
    return seen;
  };
  // What the kernel worker loads at startup (static imports only).
  const core = closure(assets.filter((f) => /^main-[\w-]+\.js$/.test(f)), false);
  const out: Record<string, Array<{ url: string; bytes: number }>> = {};
  for (const f of assets) {
    const id = /^pkg-([\w-]+?)-[\w-]{8}\.js$/.exec(f)?.[1];
    if (!id) continue;
    // Another package's chunk is that package's, not this one's.
    out[id] = [...closure([f], true, core)].filter((x) => x === f || !x.startsWith('pkg-')).map((x) => ({ url: `assets/${x}`, bytes: statSync(`${dir}/assets/${x}`).size }));
  }
  return out;
}

/**
 * Two builds from one source:
 *  - the app (default): agent window, desktop, docs, kernel and the SDK runtime → dist/
 *  - the SDK runtime (BBX_TARGET=runtime): only the UI-less embed page and the
 *    kernel it drives → packages/runtime/dist/ (or BBX_OUT), for
 *    @jeevanand/agent-browserbox-runtime and the hosted copy at /runtime/.
 */
const runtimeOnly = process.env.BBX_TARGET === 'runtime';
const input = runtimeOnly
  ? { bridge: 'kernel/bridge.html', embed: 'embed/index.html' }
  : { main: 'index.html', agent: 'agent/index.html', os: 'os/index.html', docs: 'docs/index.html', bridge: 'kernel/bridge.html', embed: 'embed/index.html' };

/** The runtime's version, reported by the kernel (and to the SDK). One source of truth: packages/runtime/package.json. */
const RUNTIME_VERSION: string = JSON.parse(readFileSync(new URL('./packages/runtime/package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [kernelChain()],
  define: { __BBX_RUNTIME_VERSION__: JSON.stringify(RUNTIME_VERSION) },
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'es2022',
    outDir: runtimeOnly ? (process.env.BBX_OUT ?? 'packages/runtime/dist') : 'dist',
    emptyOutDir: true,
    // One entry per part: redirect, agent window, desktop GUI, kernel bridge, UI-less runtime.
    rollupOptions: { input },
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 7000,
  },
  worker: {
    format: 'es',
    // Each package (src/packages/<id>/index.ts) is loaded on demand; name its chunk after it.
    rollupOptions: {
      output: {
        chunkFileNames: (chunk: { facadeModuleId: string | null }) => {
          const pkg = /\/src\/packages\/([\w-]+)\/index\.ts$/.exec(chunk.facadeModuleId ?? '')?.[1];
          return pkg ? `assets/pkg-${pkg}-[hash].js` : 'assets/[name]-[hash].js';
        },
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
