import type { ToolDef } from '@/agent/tools/types';
import type { Command } from '@/shell/shell';

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

/** The package's code: src/packages/<id>/index.ts, loaded only once installed. */
export interface PackageModule {
  commands?: Command[];
  tools?: ToolDef[];
}
