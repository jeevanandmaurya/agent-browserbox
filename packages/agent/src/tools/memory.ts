import { addMemory, entries, MEMORY_BUDGET, readMemory, removeMemory, replaceMemory, type MemoryScope } from '../memory.js';
import { obj, tool, type ToolDef } from './types.js';

/** The memory tool: the agent keeps facts across chats, one entry at a time. */
export const memoryTools: ToolDef[] = [
  tool<{ action: 'view' | 'add' | 'replace' | 'remove'; scope?: MemoryScope; text?: string; old?: string }>({
    name: 'memory',
    description: `Your memory across chats. scope "user" is about the user everywhere (preferences, how they like to work, facts about them); "project" is about the current project (how it builds, conventions, decisions). Save something when it will matter in future chats, not for this task only: add one short fact per entry. view lists the entries; replace changes the entry containing \`old\` to \`text\`; remove deletes the entry containing \`text\`. Each scope holds about ${MEMORY_BUDGET} characters: when full, merge or remove entries first. The user sees each change and can undo it.`,
    input_schema: obj(
      {
        action: { type: 'string', enum: ['view', 'add', 'replace', 'remove'] },
        scope: { type: 'string', enum: ['user', 'project'], description: 'default: project' },
        text: { type: 'string', description: 'add: the fact; replace: the new text; remove: text of the entry to delete' },
        old: { type: 'string', description: 'replace: text of the entry to change' },
      },
      ['action'],
    ),
    // The agent's own records: no prompt. Every change shows in the chat and is undoable.
    cap: () => null,
    describe: (i) => (i.action === 'view' ? `View ${i.scope ?? 'project'} memory` : `${i.action === 'add' ? 'Remember' : i.action === 'replace' ? 'Update memory' : 'Forget'}: ${(i.action === 'replace' ? i.old : i.text) ?? ''}`.slice(0, 160)),
    async run(i, tc) {
      const scope = i.scope ?? 'project';
      const project = tc.project.id;
      if (i.action === 'view') {
        const list = entries(await readMemory(tc.os, scope, project));
        return list.length ? list.map((e) => `- ${e}`).join('\n') : `(the ${scope} memory is empty)`;
      }
      if (i.action === 'add') return addMemory(tc.os, scope, project, i.text ?? '');
      if (i.action === 'replace') return replaceMemory(tc.os, scope, project, i.old ?? '', i.text ?? '');
      return removeMemory(tc.os, scope, project, i.text ?? '');
    },
  }),
];
