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
