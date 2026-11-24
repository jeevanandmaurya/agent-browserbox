import { describe, expect, it } from 'vitest';
import { Bus } from '../packages/runtime/src/kernel/bus';
import type { KernelEvents } from '../packages/runtime/src/kernel/types';
import { MemFs } from '../packages/runtime/src/kernel/vfs/memfs';
import { Vfs } from '../packages/runtime/src/kernel/vfs/vfs';

async function make() {
  const fs = new Vfs(new Bus<KernelEvents>());
  fs.mount('/', new MemFs());
  fs.markReady();
  await fs.writeFile('/proj/index.html', '<h1>hi</h1>');
  await fs.writeFile('/proj/src/app.js', 'old');
  await fs.writeFile('/proj/src/util.js', 'u');
  await fs.writeFile('/proj/assets/logo.svg', '<svg/>');
  await fs.overlay('/work/c1', '/proj', '/store/c1');
  return fs;
}
const names = async (fs: Vfs, p: string) => (await fs.readdir(p)).map((s) => s.name).sort();

describe('overlay file system', () => {
  it('shows the folder and keeps changes away from it', async () => {
    const fs = await make();
    expect(await fs.readText('/work/c1/src/app.js')).toBe('old');
    await fs.writeFile('/work/c1/src/app.js', 'new');
    await fs.writeFile('/work/c1/src/extra/x.js', 'x');
    await fs.rm('/work/c1/src/util.js');
    await fs.rm('/work/c1/assets', { recursive: true });
    expect(await fs.readText('/work/c1/src/app.js')).toBe('new');
    expect(await names(fs, '/work/c1/src')).toEqual(['app.js', 'extra']);
    expect(await names(fs, '/work/c1')).toEqual(['index.html', 'src']);
    expect(await fs.exists('/work/c1/assets/logo.svg')).toBe(false);
    // The folder itself is untouched.
    expect(await fs.readText('/proj/src/app.js')).toBe('old');
    expect(await fs.exists('/proj/src/util.js')).toBe(true);
    expect(await fs.overlayChanges('/work/c1')).toEqual([
      { path: '/assets/logo.svg', kind: 'deleted' },
      { path: '/src/app.js', kind: 'modified' },
      { path: '/src/extra/x.js', kind: 'added' },
      { path: '/src/util.js', kind: 'deleted' },
    ]);
    expect((await fs.readdir('/work')).map((s) => s.name)).toEqual(['c1']);
  });

  it('a folder deleted and made again does not show its old files', async () => {
    const fs = await make();
    await fs.rm('/work/c1/src', { recursive: true });
    await fs.writeFile('/work/c1/src/new.js', 'n');
    expect(await names(fs, '/work/c1/src')).toEqual(['new.js']);
    const ch = await fs.overlayChanges('/work/c1');
    expect(ch).toContainEqual({ path: '/src/app.js', kind: 'deleted' });
    expect(ch).toContainEqual({ path: '/src/new.js', kind: 'added' });
    await fs.overlayApply('/work/c1');
    expect(await names(fs, '/proj/src')).toEqual(['new.js']);
  });

  it('applies some or all changes, and discards', async () => {
    const fs = await make();
    await fs.writeFile('/work/c1/src/app.js', 'new');
    await fs.writeFile('/work/c1/index.html', '<h1>changed</h1>');
    await fs.rm('/work/c1/assets', { recursive: true });
    expect(await fs.overlayApply('/work/c1', ['/src'])).toEqual(['/src/app.js']);
    expect(await fs.readText('/proj/src/app.js')).toBe('new');
    expect(await fs.readText('/proj/index.html')).toBe('<h1>hi</h1>');
    expect((await fs.overlayChanges('/work/c1')).map((c) => c.path)).toEqual(['/assets/logo.svg', '/index.html']);
    await fs.overlayApply('/work/c1');
    expect(await fs.exists('/proj/assets')).toBe(false);
    expect(await fs.readText('/proj/index.html')).toBe('<h1>changed</h1>');
    expect(await fs.overlayChanges('/work/c1')).toEqual([]);
    await fs.writeFile('/work/c1/index.html', 'nope');
    await fs.overlayDiscard('/work/c1');
    expect(await fs.readText('/work/c1/index.html')).toBe('<h1>changed</h1>');
  });

  it('an unchanged rewrite is no change; changes survive a re-mount', async () => {
    const fs = await make();
    await fs.writeFile('/work/c1/src/app.js', 'old');
    expect(await fs.overlayChanges('/work/c1')).toEqual([]);
    await fs.rm('/work/c1/src/util.js');
    fs.unmount('/work/c1');
    await fs.overlay('/work/c1', '/proj', '/store/c1');
    expect(await fs.exists('/work/c1/src/util.js')).toBe(false);
    expect(await fs.overlayChanges('/work/c1')).toEqual([{ path: '/src/util.js', kind: 'deleted' }]);
  });

  it('brings back one file of a deleted folder', async () => {
    const fs = await make();
    await fs.writeFile('/proj/assets/icon.png', 'png');
    await fs.rm('/work/c1/assets', { recursive: true });
    await fs.overlayDiscard('/work/c1', ['/assets/logo.svg']);
    expect(await names(fs, '/work/c1/assets')).toEqual(['logo.svg']);
    expect(await fs.overlayChanges('/work/c1')).toEqual([{ path: '/assets/icon.png', kind: 'deleted' }]);
  });

  it('refuses an overlay inside its own folder', async () => {
    const fs = await make();
    await expect(fs.overlay('/proj/copy', '/proj', '/store/x')).rejects.toThrow(/inside/);
  });
});
