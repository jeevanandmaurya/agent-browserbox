import { getProfile, updateProfile } from '@jeevanand/agent-browserbox-runtime/client';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { PROFILE } from './boot';

/** Names nobody chose: the first profile's, and the fallback. */
const UNNAMED = new Set(['Default', 'Profile']);

/**
 * The name a person gives themselves (first boot, Settings → Appearance) also
 * names their profile, while it still has the name it started with.
 */
export async function nameProfileAfterUser(os: Kernel, name: string): Promise<void> {
  if (!name.trim()) return;
  const id = await PROFILE;
  const p = await getProfile(id).catch(() => null);
  if (p && !UNNAMED.has(p.name)) return;
  const next = await updateProfile(id, { name });
  os.settings.set('profile.name', next.name);
}
