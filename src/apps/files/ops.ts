/** Filesystem helpers for the file manager: naming, uploads, downloads. */
import type { FsApi as Vfs } from '@/kernel/api';
import { basename, join } from '@/kernel/vfs/path';
import { mimeOf } from './filetypes';

function splitName(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
}

/**
 * A free path for `name` in `dir`. 'number' keeps the name when it is free
 * ("a (2).txt" otherwise); 'copy' always derives one ("a copy.txt", "a copy 2.txt").
 */
export async function uniquePath(fs: Vfs, dir: string, name: string, style: 'number' | 'copy' = 'number'): Promise<string> {
  const [base, ext] = splitName(name);
  for (let n = style === 'number' ? 1 : 0; n < 10_000; n++) {
    const candidate = style === 'number' ? (n === 1 ? name : `${base} (${n})${ext}`) : `${base} copy${n ? ` ${n + 1}` : ''}${ext}`;
    const p = join(dir, candidate);
    if (!(await fs.exists(p))) return p;
  }
  throw new Error(`could not find a free name for ${name}`);
}

/** Validates a single file or folder name typed by the user. */
export function checkName(name: string): string | null {
  if (!name) return 'The name cannot be empty.';
  if (name.includes('/')) return 'Names cannot contain “/”.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  return null;
}

export interface Upload {
  /** Path relative to the target folder, e.g. "photos/a.png". */
  rel: string;
  file: File;
}

/**
 * Reads dropped items, including whole folders. Must be called synchronously
 * inside the drop handler: the DataTransfer is emptied once the event ends.
 */
export function droppedUploads(dt: DataTransfer): Promise<Upload[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Promise.resolve([...dt.files].map((file) => ({ rel: file.name, file })));
  const out: Upload[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
      out.push({ rel: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches until it yields an empty array.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  return Promise.all(entries.map((e) => walk(e, ''))).then(() => out);
}

/** Writes uploads into `dir`, renaming top-level items that would clash. Returns the count written. */
export async function writeUploads(fs: Vfs, dir: string, uploads: Upload[], signal?: AbortSignal): Promise<number> {
  const renamed = new Map<string, string>();
  let n = 0;
  for (const { rel, file } of uploads) {
    signal?.throwIfAborted();
    const [top, ...rest] = rel.split('/');
    if (!renamed.has(top!)) renamed.set(top!, basename(await uniquePath(fs, dir, top!)));
    await fs.writeFile(join(dir, renamed.get(top!)!, ...rest), new Uint8Array(await file.arrayBuffer()));
    n++;
  }
  return n;
}

/** Saves a VFS file to the user's real Downloads via a temporary blob URL. */
export async function download(fs: Vfs, path: string, host: HTMLElement): Promise<void> {
  const bytes = await fs.readFile(path);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(path) }));
  const a = document.createElement('a');
  a.href = url;
  a.download = basename(path);
  a.hidden = true;
  host.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
