import type { PackageManifest, PackageModule, PackageRegistry } from '@/kernel/package-types';

// Every folder in src/packages is a package. Adding one needs no other change:
// its manifest is read here and its code becomes its own build chunk.
const manifests = import.meta.glob<PackageManifest>('./*/manifest.ts', { eager: true, import: 'default' });
const modules = import.meta.glob<PackageModule>('./*/index.ts', { import: 'default' });

export const PACKAGES: readonly PackageManifest[] = Object.values(manifests).sort((a, b) => a.id.localeCompare(b.id));

export function findPackage(id: string): PackageManifest | undefined {
  return PACKAGES.find((p) => p.id === id);
}

/** The package that provides a shell command or an agent tool. */
export function providerOf(name: string, kind: 'commands' | 'tools'): PackageManifest | undefined {
  return PACKAGES.find((p) => p[kind].includes(name));
}

export function importPackage(id: string): Promise<PackageModule> {
  const load = modules[`./${id}/index.ts`];
  if (!load) return Promise.reject(new Error(`package ${id} has no code`));
  return load();
}

/** Every package in this build, for the kernel's package manager. */
export const REGISTRY: PackageRegistry = { manifests: PACKAGES, load: importPackage };
