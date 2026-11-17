import { EXT_DIRS, extId, loadExtensions, setEnabled, template, validName, type ExtKind, type Extension } from '@/agent/ext/library';
import type { AppContext } from '@/ui/apps';
import { confirmDialog, promptDialog } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { errText, heading } from './nav';

const COPY: Record<ExtKind, { title: string; intro: string; noun: string; empty: string }> = {
  skill: {
    title: 'Skills',
    noun: 'skill',
    intro: 'Reusable instructions the agent loads when a task matches. Each skill is a folder with a SKILL.md file (name and description at the top, instructions below) plus any supporting files. The agent sees only the names and descriptions until it needs one.',
    empty: 'No skills yet.',
  },
  agent: {
    title: 'Agents',
    noun: 'agent',
    intro: 'Specialised sub-agents the main agent can delegate to. Each is a Markdown file with a description, an optional list of allowed tools, and the instructions it runs with. Sub-agents start with a fresh context, which keeps long investigations out of the main conversation.',
    empty: 'No custom agents yet.',
  },
  command: {
    title: 'Commands',
    noun: 'command',
    intro: 'Prompt templates you run by typing /name in the message box. $ARGUMENTS is replaced by whatever you type after the command. Built-in commands: /compact, /context, /clear, /skills, /agents, /connectors, /model.',
    empty: 'No custom commands yet.',
  },
};

/** Lists one kind of extension with enable switches, and creates, edits and deletes their files. */
export function extensionSection(ctx: AppContext, kind: ExtKind, saved: () => void): HTMLElement {
  const { os } = ctx;
  const copy = COPY[kind];
  const list = h('ul', { class: 'st-list ex-list' });
  const error = h('p', { class: 'st-error', hidden: true });

  async function render(): Promise<void> {
    let items: Extension[];
    try {
      items = await loadExtensions(os, kind);
    } catch (err) {
      error.hidden = false;
      error.textContent = errText(err);
      return;
    }
    list.replaceChildren(...(items.length ? items.map(row) : [h('li', { class: 'muted' }, copy.empty)]));
  }

  function row(e: Extension): HTMLElement {
    const toggle = h('input', {
      type: 'checkbox',
      checked: e.enabled,
      'aria-label': `Enable ${e.name}`,
      onchange: () => {
        setEnabled(os, e, toggle.checked);
        saved();
      },
    });
    return h(
      'li',
      { class: 'ex-row', dataset: { id: extId(e) } },
      h('label', { class: 'ex-switch' }, toggle),
      h(
        'div',
        { class: 'ex-text' },
        h('span', { class: 'ex-name' }, kind === 'command' ? `/${e.name}` : e.name),
        h('span', { class: 'muted ex-desc' }, e.description || 'No description.'),
        e.tools.length ? h('span', { class: 'muted ex-meta' }, `Tools: ${e.tools.join(', ')}`) : null,
      ),
      h(
        'div',
        { class: 'ex-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => ctx.launch('editor', { path: e.path }) }, 'Edit'),
        kind === 'skill' ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => ctx.launch('files', { path: e.dir }) }, 'Folder') : null,
        h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `Delete ${e.name}`, onclick: () => void remove(e) }, 'Delete'),
      ),
    );
  }

  async function create(): Promise<void> {
    const name = (await promptDialog(`New ${copy.noun}`, 'Name (lowercase letters, digits and dashes)', ''))?.trim().toLowerCase();
    if (!name) return;
    if (!validName(name)) return os.notify({ title: 'Use lowercase letters, digits and dashes (up to 48 characters).', level: 'warn' });
    const path = kind === 'skill' ? `${EXT_DIRS.skill}/${name}/SKILL.md` : `${EXT_DIRS[kind]}/${name}.md`;
    if (await os.fs.exists(path)) return os.notify({ title: `A ${copy.noun} named ${name} already exists.`, level: 'warn' });
    await os.fs.writeFile(path, template(kind, name));
    await render();
    ctx.launch('editor', { path });
  }

  async function remove(e: Extension): Promise<void> {
    const ok = await confirmDialog(`Delete ${e.name}?`, kind === 'skill' ? `This deletes the folder ${e.dir} and everything in it.` : `This deletes ${e.path}.`, 'Delete', true);
    if (!ok) return;
    try {
      await os.fs.rm(kind === 'skill' ? e.dir : e.path, { recursive: true });
      setEnabled(os, e, true); // forget the switch state
      await render();
    } catch (err) {
      os.notify({ title: `Could not delete ${e.name}`, body: errText(err), level: 'error' });
    }
  }

  // Edits made in the editor (or by the agent) show up here straight away.
  ctx.on('fs:change', ({ path }) => path.startsWith(EXT_DIRS[kind]) && void render());
  void render();

  return h(
    'div',
    { class: 'st-section' },
    heading(copy.title, copy.intro),
    h('div', { class: 'row st-wrap' }, h('button', { class: 'btn', type: 'button', onclick: () => void create() }, `New ${copy.noun}`), h('button', { class: 'btn ghost', type: 'button', onclick: () => ctx.launch('files', { path: EXT_DIRS[kind] }) }, `Open ${EXT_DIRS[kind]}`)),
    error,
    list,
  );
}
