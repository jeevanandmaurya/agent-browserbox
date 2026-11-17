/** Plain-language one-liners for tool calls; the raw command or path is shown beside them. */
const VERBS: Record<string, string> = {
  read_file: 'Read a file',
  write_file: 'Wrote a file',
  edit_file: 'Edited a file',
  delete_path: 'Deleted a file',
  move_path: 'Moved a file',
  list_dir: 'Looked in a folder',
  glob: 'Searched for files',
  grep: 'Searched inside files',
  shell: 'Ran a command',
  run_js: 'Ran JavaScript',
  run_python: 'Ran Python',
  run_wasm: 'Ran a program',
  gpu_compute: 'Computed on the GPU',
  http_fetch: 'Fetched a web page',
  show_html: 'Showed a preview',
  open_app: 'Opened an app',
  todo_write: 'Updated the task list',
  spawn_agent: 'Asked a helper agent',
  ask_user: 'Asked you a question',
  list_processes: 'Checked running processes',
  kill_process: 'Stopped a process',
  system_info: 'Checked the system',
  clipboard_read: 'Read the clipboard',
  clipboard_write: 'Copied to the clipboard',
  notify: 'Sent a notification',
  speak: 'Spoke aloud',
  use_skill: 'Used a skill',
};

export function friendlyTool(name: string, summary: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}: ${mcp[2]!.replace(/_/g, ' ')}`;
  const verb = VERBS[name] ?? `Used ${name.replace(/_/g, ' ')}`;
  const file = /^[\w./~-]+\.\w{1,8}$/.test(summary) ? summary.split('/').pop() : '';
  return file ? `${verb.replace(/ a file$/, '')} ${file}` : verb;
}
