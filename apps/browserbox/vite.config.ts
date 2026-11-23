import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The BrowserBox app. It runs on the released packages: the SDK boots the
 * runtime, whose kernel it drives through the runtime's client, and the agent
 * package runs in its agent worker. Its build has no kernel of its own, and
 * ships the runtime it was built against, from the runtime package, at
 * /runtime/<version>/ (where the site serves runtime releases too).
 */
const RUNTIME_VERSION: string = JSON.parse(readFileSync(new URL('../../packages/runtime/package.json', import.meta.url), 'utf8')).version;

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json', '.txt': 'text/plain',
};

async function builtRuntime(): Promise<string> {
  const { runtimeDir } = (await import('@jeevanand/agent-browserbox-runtime')) as { runtimeDir: string };
  if (!existsSync(`${runtimeDir}/embed/index.html`)) throw new Error(`the runtime package is not built (${runtimeDir}): run npm run build:runtime first`);
  return runtimeDir;
}

const shipRuntime = () => ({
  name: 'bbx-ship-runtime',
  async writeBundle(options: { dir?: string }) {
    cpSync(await builtRuntime(), `${options.dir ?? 'dist'}/runtime/${RUNTIME_VERSION}`, { recursive: true });
  },
  // The dev server serves the built runtime package at the same path.
  async configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: any, next: () => void) => void) => void } }) {
    const dir = await builtRuntime();
    const prefix = `/runtime/${RUNTIME_VERSION}/`;
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      if (!url.startsWith(prefix)) return next();
      let file = join(dir, normalize(decodeURIComponent(url.slice(prefix.length))).replace(/^(\.\.[/\\])+/, ''));
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!file.startsWith(dir) || !existsSync(file)) return next();
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      res.end(readFileSync(file));
    });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [shipRuntime()],
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // One entry per page: redirect, agent window, desktop GUI, docs.
    rollupOptions: { input: { main: 'index.html', agent: 'agent/index.html', os: 'os/index.html', docs: 'docs/index.html' } },
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 7000,
  },
  worker: { format: 'es' },
});
