/**
 * Package types, as the kernel sees them. The kernel installs, caches and
 * loads packages but does not know what is inside one: the layers above add
 * what a package can contribute by augmenting `PackageModule` (the shell adds
 * `commands`, the agent adds `tools`).
 */

/**
 * What a package is, without loading its code. Lives in
 * src/packages/<id>/manifest.ts; the kernel reads every manifest at boot.
 */
export interface PackageManifest {
  id: string;
  version: string;
  summary: string;
  /** Shell commands the package provides (resolved when first typed). */
  commands: string[];
  /** Agent tools the package provides (offered to the model once installed). */
  tools: string[];
  /** Installed on first boot unless the user picks a minimal system. */
  default: boolean;
  /** Files fetched from elsewhere at install time, besides the package's own bundled code. */
  remote?: string[];
  /** Approximate size of the remote files, shown before they have been downloaded and measured. */
  remoteBytes?: number;
}

/** The package's code, loaded only once installed. Layers above the kernel add fields to it. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PackageModule {}

/** Which packages exist and how to load their code. Given to the kernel by whoever assembles it. */
export interface PackageRegistry {
  readonly manifests: readonly PackageManifest[];
  load(id: string): Promise<PackageModule>;
}

/** No packages: what a bare kernel starts with. */
export const NO_PACKAGES: PackageRegistry = {
  manifests: [],
  load: (id) => Promise.reject(new Error(`package ${id} has no code`)),
};

// ---- Packages from indexes (WASM, JavaScript, scripts) and what windows see of them

/**
 * A package from a source, described by a bbx-package.json: files to download
 * (each pinned by sha256) and the commands they provide.
 */
export type ExternalKind = 'wasm' | 'js' | 'script';

export interface PackageFile {
  path: string;
  /** Where to download it; or `text` holds it (a small wrapper script kept in the index). */
  url?: string;
  text?: string;
  sha256: string;
  bytes?: number;
}

export interface PackageCommand {
  /** The file that runs. */
  run: string;
  /** Fixed leading arguments. */
  args?: string[];
  /** JavaScript packages: library files loaded first, which `run` gets with `require(path)`. */
  load?: string[];
}

export interface ExternalPackage {
  id: string;
  version: string;
  kind: ExternalKind;
  summary: string;
  license?: string;
  homepage?: string;
  files: PackageFile[];
  /** Command name → the file that runs it (and fixed leading arguments). */
  commands: Record<string, PackageCommand>;
  /** Other packages first, as `id` or `id>=1.2`. */
  depends?: string[];
}

export interface PackageSource {
  url: string;
  /** The BrowserBox index: its packages install without asking. */
  official?: boolean;
}

export interface InstalledExternal {
  pkg: ExternalPackage;
  source: string;
  installedAt: number;
}

/** A package in a source's index, with where it came from. */
export type Listed = ExternalPackage & { source: string; official: boolean };

export interface PackageInfo extends PackageManifest {
  installed: boolean;
  /** Download size in bytes: measured from the build and the server, or the manifest's estimate before download. */
  bytes: number;
  /** True while `bytes` includes an estimate for files not yet downloaded. */
  estimated: boolean;
}

