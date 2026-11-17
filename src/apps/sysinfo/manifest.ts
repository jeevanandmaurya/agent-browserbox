import type { AppManifest } from '@/ui/app-manifest';

export default {
  id: 'sysinfo',
  name: 'System',
  icon: '⌬',
  color: '#475569',
  width: 760,
  height: 540,
  order: 8,
  singleton: true,
} satisfies AppManifest;
