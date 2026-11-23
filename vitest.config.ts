import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Unit tests for every package and the app (tests/). */
const RUNTIME_VERSION: string = JSON.parse(readFileSync(new URL('./packages/runtime/package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  define: { __BBX_RUNTIME_VERSION__: JSON.stringify(RUNTIME_VERSION) },
  resolve: { alias: { '@': fileURLToPath(new URL('./apps/browserbox/src', import.meta.url)) } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
