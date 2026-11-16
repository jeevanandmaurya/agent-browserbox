export interface Stat {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: number;
}

export class FsError extends Error {
  constructor(
    readonly code: 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'EACCES' | 'ENOTEMPTY' | 'EIO',
    path: string,
    detail?: string,
  ) {
    super(`${code}: ${detail ?? FsError.text[code]}, '${path}'`);
    this.name = 'FsError';
  }
  static text = {
    ENOENT: 'no such file or directory',
    EEXIST: 'file already exists',
    ENOTDIR: 'not a directory',
    EISDIR: 'is a directory',
    EACCES: 'permission denied',
    ENOTEMPTY: 'directory not empty',
    EIO: 'i/o error',
  } as const;
}

/**
 * A storage backend mounted somewhere in the VFS tree. Paths passed to a
 * backend are relative to its mount point, normalized, and start with '/'.
 */
export interface FsBackend {
  readonly label: string;
  readonly readonly?: boolean;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<Stat[]>;
  stat(path: string): Promise<Stat | null>;
  mkdir(path: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
}
