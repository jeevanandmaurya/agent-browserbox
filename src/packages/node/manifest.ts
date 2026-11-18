import type { PackageManifest } from '../types';

export default {
  id: 'node',
  version: '20 (WebContainers)',
  summary: 'real Node.js and npm in the browser (StackBlitz WebContainers); needs cross-origin isolation',
  commands: ['node'],
  tools: [],
  default: false,
  // The runtime itself is fetched from StackBlitz when Node first starts in a session.
} satisfies PackageManifest;
