import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The boundaries between the products, checked on every import.
 *
 * Inside the runtime (packages/runtime/src), lower layers never import higher ones:
 *   core     kernel/ kernel-worker/ sandbox/ rpc/ config/   (the headless machine)
 *   shell    shell/
 *   packages packages/                                      (installable software)
 *   client   client/ kernel-host/                           (clients of the kernel)
 * The worker's composition root (kernel-worker/main.ts) assembles them.
 *
 * The app (apps/browserbox/src) uses the products only as releases: its own
 * files and the published packages, never another package's source.
 */
const ROOT = resolve(__dirname, '..');
const RUNTIME = join(ROOT, 'packages/runtime/src');
const APP = join(ROOT, 'apps/browserbox/src');
const RANK: Record<string, number> = { kernel: 0, 'kernel-worker': 0, sandbox: 0, rpc: 0, config: 0, shell: 1, packages: 2, client: 3, 'kernel-host': 3 };
const ROOTS = new Set(['kernel-worker/main.ts']);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|js)$/.test(name)) yield p;
  }
}

/** Every module a file imports: static, dynamic and type-only. */
function specifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const statements = /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|^\s*declare module ['"]([^'"]+)['"]/gm;
  return [...src.matchAll(statements)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4])!);
}

describe('layering', () => {
  it('inside the runtime, lower layers never import higher ones', () => {
    const violations: string[] = [];
    const top = (f: string) => relative(RUNTIME, f).split(sep)[0]!;
    for (const file of files(RUNTIME)) {
      const rel = relative(RUNTIME, file).split(sep).join('/');
      if (ROOTS.has(rel)) continue;
      const own = RANK[top(file)] ?? 9;
      for (const spec of specifiers(file)) {
        if (spec.startsWith('@/')) violations.push(`${rel}: '${spec}' (the runtime uses relative imports)`);
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(RUNTIME + sep)) continue;
        if ((RANK[top(target)] ?? 9) > own) violations.push(`${rel} -> ${relative(RUNTIME, target).split(sep).join('/')}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the app imports only its own files and the published packages', () => {
    const allowed = /^(@\/|\.|@jeevanand\/agent-browserbox(-sdk|-runtime\/client|\/ui)?$)/;
    const violations: string[] = [];
    for (const file of files(APP)) {
      for (const spec of specifiers(file)) {
        if (!allowed.test(spec)) violations.push(`${relative(APP, file)}: ${spec}`);
        else if (spec.startsWith('.') && !resolve(dirname(file), spec).startsWith(APP)) violations.push(`${relative(APP, file)}: ${spec} (outside the app)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('uses no third-party VM: BrowserBox is its own runtime', () => {
    // We build our own sandbox; WebContainers (or similar) must not creep back in.
    const banned = /@webcontainer\/api|webcontainer|stackblitz/i;
    const hits: string[] = [];
    for (const dir of [RUNTIME, APP, join(ROOT, 'packages/sdk/src'), join(ROOT, 'packages/agent/src')]) for (const file of files(dir)) if (banned.test(readFileSync(file, 'utf8'))) hits.push(relative(ROOT, file));
    for (const p of ['package.json', 'apps/browserbox/package.json', 'packages/runtime/package.json']) if (banned.test(readFileSync(join(ROOT, p), 'utf8'))) hits.push(p);
    expect(hits).toEqual([]);
  });
});
