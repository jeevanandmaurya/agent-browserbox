import type { Command } from '../shell';

/** A command whose code loads the first time it runs (it stays out of the kernel's startup bundle). */
export function lazyCommand(name: string, summary: string, usage: string, load: () => Promise<Command>): Command {
  return { name, summary, usage, run: async (ctx) => (await load()).run(ctx) };
}
