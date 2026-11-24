import { APP_URL } from './config';
import { withProfile } from './boot';

/** The address of an app in a tab of its own, for this profile. */
export function appTabUrl(id: string, args: Record<string, unknown> = {}): string {
  const u = new URL(APP_URL);
  u.searchParams.set('app', id);
  // Only what survives the trip as JSON (not functions or elements).
  const plain = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && ['string', 'number', 'boolean'].includes(typeof v)));
  if (Object.keys(plain).length) u.searchParams.set('args', JSON.stringify(plain));
  return withProfile(u.href);
}

/** Opens an app in a new browser tab, on the same kernel. Returns false when the browser blocked it. */
export function openAppTab(id: string, args: Record<string, unknown> = {}): boolean {
  return !!open(appTabUrl(id, args), '_blank');
}
