import type { AppManifest } from '@/ui/app-manifest';

export default {
  id: 'settings',
  name: 'Settings',
  icon: '⚙',
  color: '#64748b',
  width: 720,
  height: 560,
  order: 9,
  singleton: true,
} satisfies AppManifest;
