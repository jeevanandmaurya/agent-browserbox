import { defineConfig } from 'vitest/config';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    // Which files make up each optional tool pack, with real sizes, so installs can show progress.
    const packs: Record<string, Array<{ url: string; bytes: number }>> = { git: [], sqlite: [], zip: [] };
    for (const f of readdirSync(`${dir}/assets`)) {
      const pack = /^pack-(git|sqlite|zip)-/.exec(f)?.[1] ?? (/^sql-wasm.*\.wasm$/.test(f) ? 'sqlite' : null);
      if (pack) packs[pack]!.push({ url: `assets/${f}`, bytes: statSync(`${dir}/assets/${f}`).size });
    }
    writeFileSync(`${dir}/kernel/packs.json`, JSON.stringify(packs));
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
  worker: {
    format: 'es',
    // Name the chunks that belong to optional tool packs so the build can list them (see kernelChain).
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/node_modules\/(isomorphic-git|buffer|base64-js|ieee754|sha\.js|pako|crc-32|async-lock|clean-git-ref|diff3|ignore|pify|readable-stream|simple-get|minimisted|is-git-ref-name-valid|path-browserify)\//.test(id)) return 'pack-git';
          if (/node_modules\/sql\.js\//.test(id)) return 'pack-sqlite';
          if (/node_modules\/fflate\//.test(id)) return 'pack-zip';
        },
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
