import type { PackageManifest } from '../types';

export default {
  id: 'git',
  version: 'isomorphic-git 1.x',
  summary: 'Version control for repositories in the virtual filesystem (clone needs a relay; no push)',
  commands: ['git'],
  tools: [],
  default: true,
} satisfies PackageManifest;
