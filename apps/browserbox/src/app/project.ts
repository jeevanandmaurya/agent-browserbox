import { GENERAL_ID, getProject, type Project } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * The project this window works in. Kept per tab (so two tabs can be in two
 * projects) and remembered as the last one used, for new tabs.
 */
const TAB_KEY = 'bbx-project';
const LAST_KEY = 'agent.project.last';

function tabValue(): string | null {
  try {
    return sessionStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

export function currentProject(os: Pick<Kernel, 'settings'>): Project {
  return getProject(os, tabValue() ?? os.settings.get<string>(LAST_KEY, GENERAL_ID));
}

export function setCurrentProject(os: Pick<Kernel, 'settings'>, id: string): void {
  try {
    sessionStorage.setItem(TAB_KEY, id);
  } catch {
    /* storage blocked: the setting still remembers it */
  }
  os.settings.set(LAST_KEY, id);
}
