import type { PackageManifest } from '../types';

export default {
  id: 'zip',
  version: 'fflate',
  summary: 'Create and extract zip archives',
  commands: ['zip', 'unzip'],
  tools: [],
  default: true,
} satisfies PackageManifest;
