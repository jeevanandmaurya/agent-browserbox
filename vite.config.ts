import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
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
