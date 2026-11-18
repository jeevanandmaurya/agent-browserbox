import type * as Esbuild from 'esbuild-wasm';

/** Where esbuild comes from: kept apart from the bundler so the kernel can set it without loading the bundler. */
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

