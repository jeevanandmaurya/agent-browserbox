/**
 * The apps a frontend can open, as far as the kernel needs to know: their ids
 * and names. The kernel itself has no apps; a frontend that has some registers
 * them at startup (see kernel-worker/main.ts), and `openApp` asks it to open one.
 * A headless runtime registers none.
 */
export interface AppInfo {
  id: string;
  name: string;
  /** Opened by other apps, not listed for people or the agent. */
  hidden?: boolean;
}

const apps: AppInfo[] = [];

export function registerApps(list: readonly AppInfo[]): void {
  for (const a of list) if (!apps.some((x) => x.id === a.id)) apps.push({ id: a.id, name: a.name, hidden: a.hidden });
}

export function listApps(): readonly AppInfo[] {
  return apps;
}
