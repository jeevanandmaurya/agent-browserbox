import { describe, expect, it } from 'vitest';
import { diffFiles, diffLines, unified } from '../packages/agent/src/diff';

const apply = (a: string[], lines: NonNullable<ReturnType<typeof diffLines>>) => {
  // Rebuilding both sides from the script proves it is a correct edit script.
  const oldSide = lines.filter((l) => l.kind !== '+').map((l) => l.text);
  const newSide = lines.filter((l) => l.kind !== '-').map((l) => l.text);
  return { oldSide, newSide };
};

describe('diff', () => {
  it('produces a correct, minimal edit script', () => {
    const a = 'a b c a b b a'.split(' ');
    const b = 'c b a b a c'.split(' ');
    const lines = diffLines(a, b)!;
    const { oldSide, newSide } = apply(a, lines);
    expect(oldSide).toEqual(a);
    expect(newSide).toEqual(b);
    expect(lines.filter((l) => l.kind !== ' ').length).toBe(5); // the classic example: D = 5
  });

  it('random edits round-trip', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 50; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 40) }, () => String(Math.floor(rnd() * 6)));
      const b = a.filter(() => rnd() > 0.2).flatMap((x) => (rnd() > 0.8 ? [x, String(Math.floor(rnd() * 6))] : [x]));
      const { oldSide, newSide } = apply(a, diffLines(a, b)!);
      expect(oldSide).toEqual(a);
      expect(newSide).toEqual(b);
    }
  });

  it('groups changes into hunks with context, and counts lines', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = before.replace('line 5\n', 'line five\n').replace('line 25\n', '');
    const d = diffFiles('/a.txt', before, after);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(2);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]!.oldStart).toBe(2);
    expect(unified(d)).toContain('@@ -2,7 +2,7 @@');
    expect(unified(d)).toContain('-line 5\n+line five');
  });

  it('handles created and deleted files', () => {
    expect(diffFiles('/n.txt', null, 'x\ny\n')).toMatchObject({ before: null, after: 'file', added: 2, removed: 0 });
    expect(diffFiles('/n.txt', 'x\n', null)).toMatchObject({ before: 'file', after: null, added: 0, removed: 1 });
  });
});
