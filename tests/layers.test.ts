import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The source is layered so the kernel can ship without the UI (the SDK's
 * headless runtime) and the agent can ship without the desktop:
 *
 *   core     kernel/ kernel-worker/ sandbox/ rpc/ config/   (headless, no UI)
 *   shell    shell/
 *   agent    agent/
 *   packages packages/
 *   app      ui/ apps/ client/ pages/ kernel-host/          (anything)
 *
 * A layer may import only from its own layer and the ones above it in this
 * list. Composition roots, which assemble the layers, may import anything.
 * Services reach upward only through registration (contributeCommands,
 * registerApps, KernelServer.use, module augmentation), never by import.
 */
const SRC = resolve(__dirname, '../src');
const RANK: Record<string, number> = { kernel: 0, 'kernel-worker': 0, sandbox: 0, rpc: 0, config: 0, shell: 1, agent: 2, packages: 3 };
const APP = 9;
const ROOTS = new Set(['kernel-worker/main.ts']);

const rankOf = (top: string) => RANK[top] ?? APP;
const topOf = (file: string) => relative(SRC, file).split(sep)[0]!;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|js)$/.test(name)) yield p;
  }
}

/** Every module a file imports: static, dynamic and type-only, through `@/` or relative paths. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1]!;
    if (spec.startsWith('@/')) out.push(join(SRC, spec.slice(2)));
    else if (spec.startsWith('.')) out.push(resolve(dirname(file), spec));
  }
  return out;
}

describe('layering', () => {
  it('lower layers never import higher ones', () => {
    const violations: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (ROOTS.has(rel)) continue;
      const own = rankOf(topOf(file));
      for (const target of importsOf(file)) {
        if (!target.startsWith(SRC + sep)) continue;
        const theirs = rankOf(topOf(target));
        if (theirs > own) violations.push(`${rel} -> ${relative(SRC, target).split(sep).join('/')}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
