import { join } from '@/kernel/vfs/path';
import { C } from '../ansi';
import type { Command } from '../shell';

/** A production build of a project: bundled and minified, ready for any static host. */
export const buildCommand: Command = {
  name: 'build',
  summary: 'production build of a project: bundled, minified, ready for any static host',
  usage: 'build [dir] [--out dist]',
  async run(ctx) {
    const { buildSite } = await import('@/kernel/dev/build');
    const outAt = ctx.args.indexOf('--out');
    const out = outAt >= 0 ? ctx.args[outAt + 1] : undefined;
    const rest = ctx.args.filter((a, i) => i !== outAt && i !== outAt + 1 && !a.startsWith('-'));
    const dir = ctx.path(rest[0] ?? '.');
    const target = ctx.path(out ?? join(dir, 'dist'));
    const started = performance.now();
    const r = await buildSite(ctx.os.fs, dir);
    if (r.errors.length) {
      for (const e of r.errors) ctx.err(`error: ${e}\n`);
      return 1;
    }
    await ctx.os.fs.rm(target, { recursive: true }).catch(() => undefined);
    let bytes = 0;
    for (const [p, data] of r.files) {
      await ctx.os.fs.writeFile(join(target, p), data);
      bytes += data.length;
    }
    ctx.out(`built ${r.files.size} files (${(bytes / 1024).toFixed(1)} KB) into ${target} in ${Math.round(performance.now() - started)} ms\n${r.backend ? `${C.yellow}${r.backend} is a backend: static hosts do not run it.${C.reset}\n` : ''}`);
  },
};
