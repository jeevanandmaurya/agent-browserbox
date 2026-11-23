import { createProject, defaultFolder, GENERAL_ID, removeProject, updateProject, type Project } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { confirmDialog, modal } from '@/ui/dialog';
import { h } from '@/ui/dom';

const field = (label: string, control: HTMLElement, note?: string) => h('label', { class: 'pj-field' }, h('span', null, label), control, note ? h('span', { class: 'muted pj-note' }, note) : null);

/** Asks for a new project's name, folder and instructions; resolves the project, or null when cancelled. */
export function newProjectDialog(os: Kernel): Promise<Project | null> {
  return new Promise((resolve) => {
    let close = () => undefined as void;
    const done = (p: Project | null) => (close(), resolve(p));
    const name = h('input', { class: 'input', placeholder: 'e.g. Portfolio site', maxlength: 60, autocomplete: 'off', autofocus: true });
    const folder = h('input', { class: 'input mono', placeholder: defaultFolder('Project'), autocomplete: 'off', spellcheck: false });
    let folderEdited = false;
    name.addEventListener('input', () => !folderEdited && (folder.value = name.value.trim() ? defaultFolder(name.value) : ''));
    folder.addEventListener('input', () => (folderEdited = true));
    const instructions = h('textarea', { class: 'textarea', rows: 4, placeholder: 'Optional: what this project is, how to build and test it, conventions to follow. Saved as AGENTS.md in the folder.' });
    const error = h('p', { class: 'st-error', role: 'alert', hidden: true });
    const create = async () => {
      try {
        const p = await createProject(os, { name: name.value, folder: folder.value });
        if (instructions.value.trim() && !(await os.fs.exists(`${p.folder}/AGENTS.md`))) await os.fs.writeFile(`${p.folder}/AGENTS.md`, `${instructions.value.trim()}\n`);
        done(p);
      } catch (err) {
        error.textContent = (err as Error).message;
        error.hidden = false;
      }
    };
    const box = h(
      'div',
      { class: 'modal pj-modal', role: 'dialog', 'aria-label': 'New project' },
      h('h3', null, 'New project'),
      h('p', { class: 'muted' }, 'A project has its own folder, chats, memory and instructions. Use an existing folder (one shared from your computer under /mnt works too) or a new one.'),
      field('Name', name),
      field('Folder', folder, 'Where the agent works. Created if it does not exist.'),
      field('Instructions', instructions),
      error,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: () => void create() }, 'Create project')),
    );
    close = modal(box, () => done(null));
    name.focus();
  });
}

/**
 * A project's settings: name, instructions (AGENTS.md), default model, pinned
 * knowledge files, and deleting it. Resolves 'deleted' when it was deleted.
 */
export function projectSettingsDialog(os: Kernel, project: Project): Promise<'deleted' | 'saved' | null> {
  return new Promise((resolve) => {
    let close = () => undefined as void;
    const done = (v: 'deleted' | 'saved' | null) => (close(), resolve(v));
    const general = project.id === GENERAL_ID;
    const name = h('input', { class: 'input', value: project.name, maxlength: 60, disabled: general });
    const model = h('input', { class: 'input mono', value: project.model ?? '', placeholder: 'The main model', autocomplete: 'off', disabled: general });
    const knowledge = h('textarea', { class: 'textarea mono', rows: 3, placeholder: 'One path per line, e.g. docs/brief.md', value: (project.knowledge ?? []).join('\n'), disabled: general });
    const instructions = h('textarea', { class: 'textarea', rows: 6, placeholder: 'How this project is built and tested, conventions, what to avoid.' });
    const agentsFile = `${project.folder}/AGENTS.md`;
    void os.fs
      .readText(agentsFile)
      .then((t) => (instructions.value = t))
      .catch(() => undefined);
    const error = h('p', { class: 'st-error', role: 'alert', hidden: true });
    const save = async () => {
      try {
        if (!general) updateProject(os, project.id, { name: name.value, model: model.value.trim(), knowledge: knowledge.value.split('\n').map((l) => l.trim()).filter(Boolean) });
        const text = instructions.value.trim();
        const had = await os.fs.exists(agentsFile);
        if (text) await os.fs.writeFile(agentsFile, `${text}\n`);
        else if (had) await os.fs.rm(agentsFile);
        done('saved');
      } catch (err) {
        error.textContent = (err as Error).message;
        error.hidden = false;
      }
    };
    const alsoFolder = h('input', { type: 'checkbox' });
    const remove = async () => {
      if (!(await confirmDialog(`Delete ${project.name}?`, `Its chats and memory are deleted.${alsoFolder.checked ? ` Its folder ${project.folder} is deleted too.` : ` Its folder ${project.folder} is kept.`} This cannot be undone.`, 'Delete project', true))) return;
      await removeProject(os, project.id, { deleteFolder: alsoFolder.checked });
      done('deleted');
    };
    const box = h(
      'div',
      { class: 'modal pj-modal', role: 'dialog', 'aria-label': `${project.name} settings` },
      h('h3', null, general ? 'General' : 'Project settings'),
      h('p', { class: 'muted mono pj-folder' }, project.folder),
      general ? h('p', { class: 'muted' }, 'The original workspace. Its name, folder and model stay as they are.') : field('Name', name),
      field('Instructions (AGENTS.md)', instructions, 'Read by the agent at the start of every chat in this project.'),
      general ? null : field('Default model', model, 'An API model id for this project’s chats; empty for the main model.'),
      general ? null : field('Pinned knowledge', knowledge, 'Files always given to the agent in this project (about 20,000 tokens in all; the rest are listed for it to read).'),
      error,
      general ? null : h('details', { class: 'pj-danger' }, h('summary', null, 'Delete this project'), h('label', { class: 'st-check' }, alsoFolder, 'Also delete its folder and files'), h('button', { class: 'btn danger', type: 'button', onclick: () => void remove() }, 'Delete project')),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: () => void save() }, 'Save')),
    );
    close = modal(box, () => done(null));
  });
}
