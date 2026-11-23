import type { KernelCore as Kernel } from './host/os.js';

/**
 * What the agent has seen of each file in this session, so it never edits a
 * file blind: an existing file must have been read (or written by the agent)
 * first, and must not have changed since. A change by the user (in the
 * Editor), by a command, or by another agent is caught and the model is asked
 * to read the file again, instead of overwriting that work.
 */
export class FileMemory {
  #digests = new Map<string, string>();

  /** Records the content the agent just read or wrote. */
  async note(path: string, content: Uint8Array | string): Promise<void> {
    this.#digests.set(path, await digest(content));
  }

  /** Throws when `path` exists but the agent has not seen its current content. */
  async check(os: Kernel, path: string): Promise<void> {
    const st = await os.fs.stat(path).catch(() => null);
    if (!st || st.kind !== 'file') return; // a new file needs no read
    const known = this.#digests.get(path);
    if (known === undefined) throw new Error(`Read ${path} first: you have not seen its current content. Use read_file, then edit it.`);
    const now = await digest(await os.fs.readFile(path));
    if (now !== known) throw new Error(`${path} changed since you last read it (by the user, a command or another agent). Read it again before editing, so their changes are kept.`);
  }

  /** A file (or every file under a folder) is gone. */
  forget(path: string): void {
    for (const p of [...this.#digests.keys()]) if (p === path || p.startsWith(`${path}/`)) this.#digests.delete(p);
  }

  /** A file or folder moved: what was seen moves with it (a copy is seen too). */
  move(from: string, to: string, copy = false): void {
    for (const [p, d] of [...this.#digests]) {
      if (p !== from && !p.startsWith(`${from}/`)) continue;
      this.#digests.set(to + p.slice(from.length), d);
      if (!copy) this.#digests.delete(p);
    }
  }

  /** After compaction the summary no longer holds file contents: everything must be read again. */
  clear(): void {
    this.#digests.clear();
  }
}

async function digest(content: Uint8Array | string): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return `${bytes.length}:${hex}`;
}
