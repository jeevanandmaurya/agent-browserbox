import { ESBUILD_FILES, ESBUILD_URL, ESBUILD_VERSION } from '@/kernel/dev/esbuild-loader';
import type { PackageManifest } from '../types';

export default {
  id: 'esbuild',
  version: ESBUILD_VERSION,
  summary: 'bundler for TypeScript, JSX and CSS (WebAssembly); used by serve',
  commands: ['esbuild'],
  tools: [],
  // 11 MB unpacked: installed when a dev server first needs it.
  default: false,
  remote: ESBUILD_FILES.map((f) => ESBUILD_URL + f),
  remoteBytes: 4_000_000,
} satisfies PackageManifest;
