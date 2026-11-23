import { PYODIDE_URL, PYTHON_RUNTIME_FILES } from '@/sandbox/python-runtime';
import type { PackageManifest } from '../types';

export default {
  id: 'python',
  version: '3.13.2 (Pyodide 0.29)',
  summary: 'CPython compiled to WebAssembly, with the standard library',
  commands: ['python', 'python3', 'pip', 'pip3'],
  tools: [],
  // 11 MB: not installed by default, so a phone is not made to download it on first boot.
  default: false,
  remote: PYTHON_RUNTIME_FILES.map((f) => PYODIDE_URL + f),
  remoteBytes: 12_000_000,
} satisfies PackageManifest;
