import type { AppManifest } from '@/ui/app-manifest';

export default {
  id: 'settings',
  name: 'Settings',
  icon: 'gear',
  width: 720,
  height: 560,
  order: 9,
  singleton: true,
} satisfies AppManifest;
