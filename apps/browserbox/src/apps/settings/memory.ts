import { MEMORY_AUTO_KEY, MEMORY_BUDGET, memoryPath, type MemoryScope } from '@jeevanand/agent-browserbox/ui';
import { currentProject } from '@/app/project';
import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { errText, heading, nextId } from './nav';

/**
 * What the agent remembers: about you (everywhere) and about the current
 * project. Plain Markdown, one fact per line, editable here; changes apply
 * from the next chat.
 */
export function memorySection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const project = currentProject(os);

  const auto = h('input', { type: 'checkbox', checked: os.settings.get<boolean>(MEMORY_AUTO_KEY, true) !== false, onchange: () => (os.settings.set(MEMORY_AUTO_KEY, auto.checked), saved()) });

  const editor = (scope: MemoryScope, title: string, note: string) => {
    const path = memoryPath(scope, project.id);
    const id = nextId('mem');
    const area = h('textarea', { class: 'textarea mono', id, rows: 8, placeholder: '- One fact per line' });
    const status = h('p', { class: 'st-note muted', role: 'status' });
    const count = () => (status.textContent = `${area.value.length.toLocaleString()} of about ${MEMORY_BUDGET.toLocaleString()} characters · ${path}`);
    void os.fs
      .readText(path)
      .then((t) => ((area.value = t), count()))
      .catch(() => count());
    area.addEventListener('input', count);
    const save = async () => {
      try {
        await os.fs.writeFile(path, area.value.trim() ? `${area.value.trim()}\n` : '');
        saved();
      } catch (err) {
        status.textContent = `Could not save: ${errText(err)}`;
      }
    };
    const clear = async () => {
      if (!(await confirmDialog(`Clear ${title.toLowerCase()}?`, 'Everything the agent remembers here is deleted.', 'Clear', true))) return;
      area.value = '';
      await os.fs.rm(path).catch(() => undefined);
      count();
      saved();
    };
    return h(
      'div',
      { class: 'st-panel' },
      h('h3', null, h('label', { for: id }, title)),
      h('p', { class: 'muted st-note' }, note),
      area,
      status,
      h('div', { class: 'row st-wrap' }, h('button', { class: 'btn primary', type: 'button', onclick: () => void save() }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: () => void clear() }, 'Clear')),
    );
  };

  return h(
    'div',
    { class: 'st-section' },
    heading('Memory', 'What the agent remembers between chats. It is given to the agent at the start of each chat.'),
    h('label', { class: 'st-check' }, auto, 'Let the agent save memories itself (each one shows in the chat, with undo)'),
    h('p', { class: 'muted st-note' }, 'You can always add one with /remember <fact> and remove one with /forget <text> in the message box.'),
    editor('user', 'About you', 'Everywhere: your preferences and how you like to work.'),
    editor('project', `This project: ${project.name}`, 'Only in this project: how it builds, conventions, decisions.'),
  );
}
