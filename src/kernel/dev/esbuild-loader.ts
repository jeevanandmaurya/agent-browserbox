import { PACKAGE_CACHE } from '@/sandbox/python-runtime';
import type { EsbuildApi } from './bundle';

/** esbuild compiled to WebAssembly, installed as the `esbuild` package. */
export const ESBUILD_VERSION = '0.25.5';
export const ESBUILD_URL = `https://cdn.jsdelivr.net/npm/esbuild-wasm@${ESBUILD_VERSION}/`;
export const ESBUILD_FILES = ['esm/browser.min.js', 'esbuild.wasm'];

interface Packages {
  isInstalled(id: string): boolean;
  install(id: string, progress?: (loaded: number, total: number) => void): Promise<void>;
}

/**
 * Loads esbuild from the package cache, installing the package first if
 * needed (a dev server starting a TypeScript project needs it at once).
 */
export async function loadEsbuild(packages: Packages, log: (msg: string) => void): Promise<EsbuildApi> {
  if (!packages.isInstalled('esbuild')) {
    log('installing the esbuild package for the dev server');
    await packages.install('esbuild');
  }
  const cache = await caches.open(PACKAGE_CACHE);
  const file = async (name: string) => (await cache.match(ESBUILD_URL + name)) ?? fetch(ESBUILD_URL + name);
  const src = await (await file(ESBUILD_FILES[0]!)).text();
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    const mod = (await import(/* @vite-ignore */ url)) as EsbuildApi & { initialize(o: { wasmModule: WebAssembly.Module; worker: boolean }): Promise<void> };
    const wasm = await WebAssembly.compile(await (await file(ESBUILD_FILES[1]!)).arrayBuffer());
    await mod.initialize({ wasmModule: wasm, worker: false });
    log(`esbuild ${ESBUILD_VERSION} ready`);
    return mod;
  } finally {
    URL.revokeObjectURL(url);
  }
}
