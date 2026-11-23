import type { AppManifest } from '@/ui/app-manifest';

export default {
  id: 'sysinfo',
  name: 'System',
  icon: 'info',
  width: 760,
  height: 540,
  order: 8,
  singleton: true,
} satisfies AppManifest;
