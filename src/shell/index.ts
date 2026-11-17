import { agentCommand } from './commands/agent';
import { npmCommand, npxCommand, serveCommand } from './commands/dev';
import { execCommands } from './commands/exec';
import { fsCommands } from './commands/fs';
import { dmesgCommand, pkgCommand } from './commands/pkg';
import { setupCommand } from './commands/setup';
import { sysCommands } from './commands/sys';
import { textCommands } from './commands/text';
import type { Shell } from './shell';

/** Installs the standard command set. Add a command by adding it to one of these lists. */
export function registerCommands(shell: Shell): Shell {
  return shell.register(...fsCommands, ...textCommands, ...sysCommands, ...execCommands, pkgCommand, dmesgCommand, setupCommand, agentCommand, serveCommand, npmCommand, npxCommand);
}

export { Shell } from './shell';
export type { Command, CommandContext, Tty } from './shell';
