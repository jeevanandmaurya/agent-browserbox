import type { Kernel } from '@/kernel/api';
import type { Transcript } from './view';
import type { Workbench } from './workbench';

export type Profile = 'dev' | 'casual';

export function getProfile(os: Kernel): Profile {
  return os.settings.get<string>('ui.profile', 'casual') === 'dev' ? 'dev' : 'casual';
}

/**
 * Applies the UI profile. CSS does most of it through `data-profile`
 * (density, technical status, friendly tool labels); this handles the rest.
 * `workbench` is passed on first load only, to open the dev tools on wide screens.
 */
export function applyProfile(os: Kernel, root: HTMLElement, log: Transcript, workbench: Workbench | null): void {
  const p = getProfile(os);
  root.dataset.profile = p;
  log.expandTools = p === 'dev';
  if (workbench && p === 'dev' && !matchMedia('(max-width: 900px)').matches) {
    workbench.open('terminal');
    workbench.open('files');
  }
}
