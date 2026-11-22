import { defineConfig } from 'vite';

/** The SDK package (@jeevanand/browserbox): one small ES module, no dependencies. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'packages/sdk/dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: true,
    lib: { entry: 'src/sdk/index.ts', formats: ['es'], fileName: () => 'index.js' },
  },
});
