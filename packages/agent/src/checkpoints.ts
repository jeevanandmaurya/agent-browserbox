import type { Kernel } from './host/os.js';

/** What one file looked like before the agent first changed it during a turn. */
export interface FileSnap {
  path: string;
  /** null: the file did not exist. Text, or base64 when `binary`. */
  before: string | null;
  binary?: boolean;
  /** Too large (or over the session's budget) to keep: it cannot be restored. */
  skipped?: boolean;
}

/** One turn: the files changed while answering the user message at transcript index `turn`. */
export interface Checkpoint {
  turn: number;
  at: number;
  files: FileSnap[];
}

const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 24 * 1024 * 1024;
const MAX_DIR_FILES = 500;

const isText = (b: Uint8Array) => !b.subarray(0, 8192).includes(0);
const toBase64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Checkpoints for undo. Before a file tool writes, moves or deletes, the
 * original of each affected file is kept (once per turn), so the turn's
 * changes can be put back. Changes made by shell commands or code are not
 * tracked: only the file tools'.
 */
export class Checkpoints {
  list: Checkpoint[] = [];

  constructor(private os: Kernel) {}

  begin(turn: number): void {
    this.list.push({ turn, at: Date.now(), files: [] });
  }

  #size(): number {
    return this.list.reduce((n, c) => n + c.files.reduce((m, f) => m + (f.before?.length ?? 0), 0), 0);
  }

  /** Records the current content of these paths (and the files inside folders) before a change. Returns what each file was. */
  async capture(paths: string[]): Promise<Map<string, string | null>> {
    const cp = this.list.at(-1);
    const seen = new Map<string, string | null>();
    if (!cp) return seen;
    const files: string[] = [];
    for (const p of paths) {
      const st = await this.os.fs.stat(p).catch(() => null);
      if (st?.kind === 'dir') {
        let n = 0;
        for await (const s of this.os.fs.walk(p)) {
          if (s.kind !== 'file') continue;
          // Past the limit the folder cannot be fully restored: say so instead of restoring part of it quietly.
          if (++n > MAX_DIR_FILES) {
            if (!cp.files.some((f) => f.path === p)) cp.files.push({ path: p, before: null, skipped: true });
            break;
          }
          files.push(s.path);
        }
      } else files.push(p);
    }
    for (const path of files) {
      let snap = cp.files.find((f) => f.path === path);
      if (!snap) {
        const st = await this.os.fs.stat(path).catch(() => null);
        if (!st) snap = { path, before: null };
        else if (st.kind !== 'file' || st.size > MAX_FILE || this.#size() + st.size > MAX_TOTAL) snap = { path, before: null, skipped: true };
        else {
          const bytes = await this.os.fs.readFile(path);
          snap = isText(bytes) ? { path, before: new TextDecoder().decode(bytes) } : { path, before: toBase64(bytes), binary: true };
        }
        cp.files.push(snap);
      }
      seen.set(path, snap.binary || snap.skipped ? null : snap.before);
    }
    return seen;
  }

  /** Records that `path` did not exist before this turn (it was just created), so undo removes it. */
  created(path: string): void {
    const cp = this.list.at(-1);
    if (cp && !cp.files.some((f) => f.path === path)) cp.files.push({ path, before: null });
  }

  /** Files changed at or after transcript index `turn`, each with its content before the first of those changes. */
  since(turn: number): FileSnap[] {
    const out = new Map<string, FileSnap>();
    for (const cp of this.list) if (cp.turn >= turn) for (const f of cp.files) if (!out.has(f.path)) out.set(f.path, f);
    // A folder that did not exist then: nothing inside it did either, whatever later turns saved of it.
    const absent = [...out.values()].filter((f) => f.before === null && !f.skipped).map((f) => f.path);
    return [...out.values()].filter((f) => !absent.some((a) => f.path.startsWith(`${a}/`)));
  }

  /** Puts files back as they were before the turn at `turn`, and forgets the later checkpoints. */
  async restore(turn: number): Promise<{ restored: string[]; skipped: string[] }> {
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const f of this.since(turn)) {
      if (f.skipped) {
        skipped.push(f.path);
        continue;
      }
      if (f.before === null) await this.os.fs.rm(f.path, { recursive: true }).catch(() => undefined);
      else await this.os.fs.writeFile(f.path, f.binary ? fromBase64(f.before) : f.before);
      restored.push(f.path);
    }
    this.drop(turn);
    return { restored, skipped };
  }

  drop(turn: number): void {
    this.list = this.list.filter((c) => c.turn < turn);
  }
}
