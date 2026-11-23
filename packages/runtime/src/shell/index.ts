import { buildCommand } from './commands/build';
import { npmCommand, npxCommand, serveCommand } from './commands/dev';
import { execCommands } from './commands/exec';
import { fsCommands } from './commands/fs';
import { dmesgCommand, pkgCommand } from './commands/pkg';
import { sysCommands } from './commands/sys';
import { textCommands } from './commands/text';
import { contribute } from './contrib';
import type { Command, Shell } from './shell';
import { profileCommands } from './commands/profile';

/**
 * Adds commands to every shell (see contrib.ts): how others offer commands
 * without the shell depending on them.
 */
export function contributeCommands(...cmds: Command[]): void {
  for (const c of cmds) contribute(c);
}

/** Installs the standard command set. Add a command by adding it to one of these lists; contributed ones are looked up live. */
export function registerCommands(shell: Shell): Shell {
  return shell.register(...fsCommands, ...textCommands, ...sysCommands, ...execCommands, pkgCommand, dmesgCommand, serveCommand, npmCommand, npxCommand, buildCommand, ...profileCommands);
}

export { Shell } from './shell';
export type { Command, CommandContext, Tty } from './shell';
