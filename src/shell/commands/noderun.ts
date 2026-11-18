import { dirname, join } from '@/kernel/vfs/path';
import { nodeRun } from '@/sandbox/sandbox';
import type { CommandContext } from '../shell';

/** The project a command belongs to: the nearest folder with a package.json, else the working folder. */
async function projectRoot(ctx: CommandContext): Promise<string> {
  for (let dir = ctx.shell.cwd; ; dir = dirname(dir)) {
    if (await ctx.os.fs.exists(join(dir, 'package.json'))) return dir;
    if (dir === '/' || dir === '/home') return ctx.shell.cwd;
  }
}

/**
 * Runs node, npm or npx in WebContainers (the node package) for the current
 * project, streaming output; ^C stops it. Returns the exit code.
 */
export async function runInNode(ctx: CommandContext, cmd: 'node' | 'npm' | 'npx', args: string[]): Promise<number> {
  const root = await projectRoot(ctx);
  const r = await nodeRun(ctx.os, { root, cwd: ctx.shell.cwd, cmd, args, // Only the user's variables (Settings → Environment): the container has its own PATH and HOME.
      env: { ...ctx.os.settings.get<Record<string, string>>('env.vars', {}), CI: '1', FORCE_COLOR: '1' } }, { onStdout: ctx.out, signal: ctx.signal });
  return r.code;
}
