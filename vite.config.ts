import { defineConfig } from 'vitest/config';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    for (const page of ['agent/index.html', 'os/index.html']) {
      const path = `${dir}/${page}`;
      writeFileSync(path, readFileSync(path, 'utf8').replace('  </head>', `${links}\n  </head>`));
    }
  },
});

export default defineConfig({
  plugins: [kernelChain()],
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'es2022',
    // One entry per part: redirect, agent window, desktop GUI, kernel bridge.
    rollupOptions: { input: { main: 'index.html', agent: 'agent/index.html', os: 'os/index.html', bridge: 'kernel/bridge.html' } },
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 7000,
  },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
