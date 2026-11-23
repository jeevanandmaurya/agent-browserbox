import { bundle } from '../../kernel/dev/bundle';
import { basename, dirname, extname } from '../../kernel/vfs/path';
import type { Command } from '../../shell/shell';
import type { PackageModule } from '../types';

/** `esbuild entry --outfile=out.js`: the dev server's bundler, for builds that write files. */
const esbuildCommand: Command = {
  name: 'esbuild',
  summary: 'bundle TypeScript/JSX/CSS into files (npm packages from esm.sh)',
  usage: 'esbuild src/main.tsx --outfile=dist/app.js   (also writes dist/app.css when there is CSS)',
  async run(ctx) {
    const entryArg = ctx.args.find((a) => !a.startsWith('-'));
    const outArg = ctx.args.find((a) => a.startsWith('--outfile='))?.slice('--outfile='.length);
    if (!entryArg) throw new Error('usage: esbuild <entry> --outfile=<file>');
    const entry = ctx.path(entryArg);
    const outfile = ctx.path(outArg ?? `dist/${basename(entry).replace(/\.\w+$/, '')}.js`);
    const root = ctx.shell.cwd;
    const pkg = await ctx.os.fs.readText(`${root}/package.json`).then((t) => JSON.parse(t), () => null);
    const started = performance.now();
    const out = await bundle({ fs: ctx.os.fs, root, entry, target: 'browser', pkg });
    for (const w of out.warnings) ctx.err(`warning: ${w}\n`);
    if (out.errors.length) {
      for (const e of out.errors) ctx.err(`error: ${e}\n`);
      return 1;
    }
    await ctx.os.fs.mkdir(dirname(outfile));
    await ctx.os.fs.writeFile(outfile, out.js);
    ctx.out(`${outfile}  ${(out.js.length / 1024).toFixed(1)} KB\n`);
    if (out.css) {
      const cssFile = outfile.slice(0, -extname(outfile).length - 1) + '.css';
      await ctx.os.fs.writeFile(cssFile, out.css);
      ctx.out(`${cssFile}  ${(out.css.length / 1024).toFixed(1)} KB\n`);
    }
    ctx.out(`done in ${Math.round(performance.now() - started)} ms\n`);
  },
};

export default { commands: [esbuildCommand] } satisfies PackageModule;
