import type { AppManifest } from '@/ui/app-manifest';

export default {
  id: 'taskmgr',
  name: 'Task Manager',
  icon: '◔',
  color: '#dc2626',
  width: 760,
  height: 500,
  order: 5,
  singleton: true,
} satisfies AppManifest;
