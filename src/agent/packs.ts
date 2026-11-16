/**
 * Optional tool packs the user can pick during setup (stored as `setup.packs`).
 * Packs download only when first used. Only the selection is stored here;
 * installing and wiring a pack is the kernel's job.
 */
export interface ToolPack {
  id: string;
  name: string;
  description: string;
  /** Approximate download size, for display. */
  size: string;
  /** False while the pack is not built yet ("coming soon"). */
  available: boolean;
}

export const PACKS: readonly ToolPack[] = [
  { id: 'python', name: 'Python', description: 'CPython compiled to WebAssembly, with the standard library. Lets the agent run Python scripts.', size: '~10 MB', available: true },
  { id: 'git', name: 'Git', description: 'Local repositories: commit, branch, diff and log inside the virtual filesystem.', size: '~2 MB', available: false },
  { id: 'sqlite', name: 'SQLite', description: 'A real SQL database engine for files in the workspace.', size: '~1 MB', available: false },
  { id: 'zip', name: 'Zip', description: 'Create and extract zip archives.', size: '<1 MB', available: false },
  { id: 'c', name: 'C compiler', description: 'Compile and run C programs to WebAssembly. A large download.', size: '~60 MB', available: false },
];

export const PACKS_KEY = 'setup.packs';
export const DEFAULT_PACKS = ['python'];
