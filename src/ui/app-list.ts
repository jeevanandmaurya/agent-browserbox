/** App ids and names without any UI code, so the kernel can refer to apps it never loads. */
export const APP_INFO: ReadonlyArray<{ id: string; name: string; hidden?: boolean }> = [
  { id: 'agent', name: 'Agent' },
  { id: 'terminal', name: 'Terminal' },
  { id: 'files', name: 'Files' },
  { id: 'editor', name: 'Editor' },
  { id: 'taskmgr', name: 'Task Manager' },
  { id: 'browser', name: 'Browser' },
  { id: 'gpulab', name: 'GPU Lab' },
  { id: 'sysinfo', name: 'System' },
  { id: 'settings', name: 'Settings' },
  { id: 'preview', name: 'Preview', hidden: true },
];
