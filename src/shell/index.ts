import { buildCommand } from './commands/build';
import { npmCommand, npxCommand, serveCommand } from './commands/dev';
import { execCommands } from './commands/exec';
import { fsCommands } from './commands/fs';
import { dmesgCommand, pkgCommand } from './commands/pkg';
import { sysCommands } from './commands/sys';
import { textCommands } from './commands/text';
import type { Command, Shell } from './shell';

const contributed: Command[] = [];

/**
 * Adds commands to every shell opened from now on. This is how layers above
 * the shell (the agent: `agent`, `setup`, `gh`, `deploy`, `build`) offer
 * commands without the shell depending on them.
 */
export function contributeCommands(...cmds: Command[]): void {
  for (const c of cmds) if (!contributed.some((x) => x.name === c.name)) contributed.push(c);
}

/** Installs the standard command set plus contributed ones. Add a command by adding it to one of these lists. */
export function registerCommands(shell: Shell): Shell {
  return shell.register(...fsCommands, ...textCommands, ...sysCommands, ...execCommands, pkgCommand, dmesgCommand, serveCommand, npmCommand, npxCommand, buildCommand, ...contributed);
}

export { Shell } from './shell';
export type { Command, CommandContext, Tty } from './shell';
