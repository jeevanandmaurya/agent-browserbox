import type { Command } from './shell';

/**
 * Commands offered by others: layers above the shell in the same worker, or
 * kernel clients (an app's agent contributes `agent`, `setup`, `gh` and
 * `deploy`, run in the app). Looked up live, so a command contributed after a
 * shell opened is still found, and one withdrawn is gone.
 */
const contributed = new Map<string, Command>();

export function contribute(cmd: Command): void {
  contributed.set(cmd.name, cmd);
}

export function withdraw(name: string, cmd?: Command): void {
  if (!cmd || contributed.get(name) === cmd) contributed.delete(name);
}

export function findContributed(name: string): Command | undefined {
  return contributed.get(name);
}

export function contributedNames(): string[] {
  return [...contributed.keys()];
}
