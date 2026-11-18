import type { AppManifest } from '@/ui/app-manifest';

export default {
  id: 'help',
  name: 'Help',
  icon: 'question',
  width: 980,
  height: 680,
  order: 9,
  singleton: true,
} satisfies AppManifest;
