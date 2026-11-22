/**
 * Line diffs for showing what the agent changed in a file. Myers' algorithm
 * (O((N+M)·D)), with a guard for very different large files.
 */

export type DiffLine = { kind: ' ' | '+' | '-'; text: string; old?: number; new?: number };
export interface Hunk {
  /** 1-based first line in the old and new file. */
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
export interface FileDiff {
  path: string;
  /** null: the file did not exist before (created) or does not exist now (deleted). */
  before: 'file' | null;
  after: 'file' | null;
  added: number;
  removed: number;
  hunks: Hunk[];
  /** Set when the file is too large or binary to diff line by line. */
  note?: string;
}

const MAX_LINES = 20_000;
const MAX_EDITS = 4_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** The shortest edit script between two line arrays, as a list of lines in order. */
export function diffLines(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return null;
  // Walk back through the trace to recover the edits.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: ' ', text: a[x - 1]!, old: x, new: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ kind: '+', text: b[y - 1]!, new: y });
      else out.push({ kind: '-', text: a[x - 1]!, old: x });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** A diff of two versions of a file, grouped into hunks with `context` unchanged lines around each change. */
export function diffFiles(path: string, before: string | null, after: string | null, context = 3): FileDiff {
  const base: FileDiff = { path, before: before === null ? null : 'file', after: after === null ? null : 'file', added: 0, removed: 0, hunks: [] };
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { ...base, note: 'Too large to show line by line.' };
  const lines = diffLines(a, b);
  if (!lines) return { ...base, added: b.length, removed: a.length, note: 'Changed throughout; too different to show line by line.' };
  base.added = lines.filter((l) => l.kind === '+').length;
  base.removed = lines.filter((l) => l.kind === '-').length;
  // Group changed lines with their context into hunks.
  const changed = lines.map((l, i) => (l.kind === ' ' ? -1 : i)).filter((i) => i >= 0);
  let i = 0;
  while (i < changed.length) {
    let start = Math.max(0, changed[i]! - context);
    let end = Math.min(lines.length - 1, changed[i]! + context);
    while (i + 1 < changed.length && changed[i + 1]! - context <= end + 1) {
      i++;
      end = Math.min(lines.length - 1, changed[i]! + context);
    }
    const slice = lines.slice(start, end + 1);
    const first = slice[0]!;
    base.hunks.push({ oldStart: first.old ?? (slice.find((l) => l.old)?.old ?? 1), newStart: first.new ?? (slice.find((l) => l.new)?.new ?? 1), lines: slice });
    i++;
    start = end;
  }
  return base;
}

/** The diff as unified-diff text (for copying, or for the model). */
export function unified(d: FileDiff): string {
  const head = `--- ${d.before ? `a${d.path}` : '/dev/null'}\n+++ ${d.after ? `b${d.path}` : '/dev/null'}\n`;
  if (d.note) return `${head}${d.note}\n`;
  return (
    head +
    d.hunks
      .map((h) => {
        const oldLen = h.lines.filter((l) => l.kind !== '+').length;
        const newLen = h.lines.filter((l) => l.kind !== '-').length;
        return `@@ -${h.oldStart},${oldLen} +${h.newStart},${newLen} @@\n${h.lines.map((l) => l.kind + l.text).join('\n')}`;
      })
      .join('\n') +
    '\n'
  );
}
