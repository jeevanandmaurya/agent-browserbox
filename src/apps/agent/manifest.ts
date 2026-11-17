import { AGENT_URL } from '@/config/origins';
import type { AppManifest } from '@/ui/app-manifest';

export default {
  id: 'agent',
  name: 'Agent',
  icon: 'spark',
  width: 520,
  height: 760,
  order: 1,
  // The agent runs in its own browser window, not inside the desktop.
  external: AGENT_URL,
} satisfies AppManifest;
