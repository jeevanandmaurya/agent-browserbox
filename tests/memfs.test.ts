import { describe, expect, it } from 'vitest';
import { Bus } from '../packages/runtime/src/kernel/bus';
import type { KernelEvents } from '../packages/runtime/src/kernel/types';
import { MemFs } from '../packages/runtime/src/kernel/vfs/memfs';
import { Vfs } from '../packages/runtime/src/kernel/vfs/vfs';

function make() {
  const bus = new Bus<KernelEvents>();
  const fs = new Vfs(bus);
  fs.mount('/', new MemFs());
  fs.mount('/tmp', new MemFs());
  fs.markReady();
  return { fs, bus };
}

describe('vfs', () => {
  it('writes, reads and creates parents', async () => {
    const { fs } = make();
    await fs.writeFile('/a/b/c.txt', 'hi');
    expect(await fs.readText('/a/b/c.txt')).toBe('hi');
    expect((await fs.readdir('/a')).map((s) => `${s.kind}:${s.name}`)).toEqual(['dir:b']);
  });
  it('routes to mounts and lists mount points', async () => {
    const { fs } = make();
    await fs.writeFile('/tmp/x', '1');
    expect((await fs.readdir('/')).map((s) => s.name)).toContain('tmp');
    expect((await fs.stat('/tmp/x'))?.path).toBe('/tmp/x');
    await expect(fs.rm('/tmp', { recursive: true })).rejects.toThrow(/mount point/);
  });
  it('copies and moves trees across mounts', async () => {
    const { fs } = make();
    await fs.writeFile('/src/a.txt', 'A');
    await fs.writeFile('/src/d/b.txt', 'B');
    await fs.mv('/src', '/tmp/dst');
    expect(await fs.exists('/src')).toBe(false);
    expect(await fs.readText('/tmp/dst/d/b.txt')).toBe('B');
    await expect(fs.cp('/tmp/dst', '/tmp/dst/inner')).rejects.toThrow(/into itself/);
  });
  it('globs and appends', async () => {
    const { fs } = make();
    await fs.writeFile('/p/a.ts', '');
    await fs.writeFile('/p/q/b.ts', '');
    await fs.writeFile('/p/q/c.js', '');
    expect(await fs.glob('**/*.ts', '/p')).toEqual(['/p/a.ts', '/p/q/b.ts']);
    await fs.appendFile('/p/log', 'a');
    await fs.appendFile('/p/log', 'b');
    expect(await fs.readText('/p/log')).toBe('ab');
  });
  it('emits change events and reports errors with codes', async () => {
    const { fs, bus } = make();
    const seen: string[] = [];
    bus.on('fs:change', (c) => seen.push(`${c.type}:${c.path}`));
    await fs.writeFile('/f', 'x');
    await fs.rm('/f');
    expect(seen).toEqual(['write:/f', 'remove:/f']);
    await expect(fs.readFile('/nope')).rejects.toThrow(/ENOENT/);
    await fs.mkdir('/d/e');
    await expect(fs.rm('/d')).rejects.toThrow(/ENOTEMPTY/);
  });
});
