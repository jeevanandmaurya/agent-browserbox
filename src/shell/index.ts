import { agentCommand } from './commands/agent';
import { execCommands } from './commands/exec';
import { fsCommands } from './commands/fs';
import { packCommands } from './commands/packs';
import { sysCommands } from './commands/sys';
import { textCommands } from './commands/text';
import type { Shell } from './shell';

/** Installs the standard command set. Add a command by adding it to one of these lists. */
export function registerCommands(shell: Shell): Shell {
  return shell.register(...fsCommands, ...textCommands, ...sysCommands, ...execCommands, ...packCommands, agentCommand);
}

export { Shell } from './shell';
export type { Command, CommandContext, Tty } from './shell';
