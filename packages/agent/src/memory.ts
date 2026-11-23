import type { WithFiles, WithSettings } from './host/os.js';
import { AGENT_HOME } from './host/paths.js';

/**
 * Memory: facts worth keeping across chats, one per line, in plain Markdown
 * files the user can read and edit.
 *   user     about the user, everywhere:   /home/agent/MEMORY.md
 *   project  about one project:            /home/agent/.memory/<project>.md
 * The agent changes them one entry at a time (the memory tool), so an entry is
 * never lost to a rewrite. The system prompt takes a snapshot at the start of
 * each chat.
 */
export type MemoryScope = 'user' | 'project';
export const MEMORY_AUTO_KEY = 'agent.memory.auto';
/** Characters per scope; past this, entries must be merged or dropped first. */
export const MEMORY_BUDGET = 6000;

export const memoryPath = (scope: MemoryScope, project: string) => (scope === 'user' ? `${AGENT_HOME}/MEMORY.md` : `${AGENT_HOME}/.memory/${project}.md`);

const HEADER: Record<MemoryScope, string> = {
  user: '# Memory\n\nWhat the agent remembers about you, one fact per line. Edit freely.\n',
  project: '# Project memory\n\nWhat the agent remembers about this project, one fact per line. Edit freely.\n',
};

/** Whether the agent may save memories on its own (the user can always use /remember). */
export const autoMemory = (os: WithSettings) => os.settings.get<boolean>(MEMORY_AUTO_KEY, true) !== false;

export async function readMemory(os: WithFiles, scope: MemoryScope, project: string): Promise<string> {
  return os.fs.readText(memoryPath(scope, project)).catch(() => '');
}

/** The entries: list items (`- …`), in order. */
export function entries(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => /^\s*[-*]\s+\S/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
}

async function write(os: WithFiles, scope: MemoryScope, project: string, list: string[], before: string): Promise<void> {
  // Keep what the user wrote around the entries (headings, notes); replace only the list.
  const lines = before.split('\n');
  const first = lines.findIndex((l) => /^\s*[-*]\s+\S/.test(l));
  const head = (first < 0 ? before || HEADER[scope] : lines.slice(0, first).join('\n')).replace(/\n*$/, '\n\n');
  const rest = first < 0 ? '' : lines.slice(first).filter((l) => !/^\s*[-*]\s+\S/.test(l)).join('\n').trim();
  await os.fs.writeFile(memoryPath(scope, project), `${head}${list.map((e) => `- ${e}`).join('\n')}\n${rest ? `\n${rest}\n` : ''}`);
}

const today = () => new Date().toISOString().slice(0, 10);
const find = (list: string[], text: string) => {
  const t = text.trim().toLowerCase();
  const hits = list.map((e, i) => [e, i] as const).filter(([e]) => e.toLowerCase().includes(t));
  if (!t || !hits.length) throw new Error(`No memory entry contains "${text}".`);
  if (hits.length > 1) throw new Error(`"${text}" is in ${hits.length} entries; quote more of the one you mean.`);
  return hits[0]![1];
};

export async function addMemory(os: WithFiles, scope: MemoryScope, project: string, fact: string): Promise<string> {
  const text = fact.trim().replace(/\s*\n\s*/g, ' ');
  if (!text) throw new Error('Nothing to remember.');
  const before = await readMemory(os, scope, project);
  const list = entries(before);
  if (list.some((e) => e.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, '').toLowerCase() === text.toLowerCase())) return `Already remembered: ${text}`;
  const entry = `${text} (${today()})`;
  if ([...list, entry].join('\n').length > MEMORY_BUDGET) throw new Error(`The ${scope} memory is full (${MEMORY_BUDGET} characters). Merge or remove entries first (memory replace / remove), then add this.`);
  await write(os, scope, project, [...list, entry], before);
  return `Remembered: ${text}`;
}

export async function replaceMemory(os: WithFiles, scope: MemoryScope, project: string, old: string, fact: string): Promise<string> {
  const before = await readMemory(os, scope, project);
  const list = entries(before);
  const i = find(list, old);
  const text = fact.trim().replace(/\s*\n\s*/g, ' ');
  if (!text) throw new Error('The new text is empty; use remove to delete an entry.');
  list[i] = `${text} (${today()})`;
  if (list.join('\n').length > MEMORY_BUDGET) throw new Error(`That would make the ${scope} memory too long; shorten it.`);
  await write(os, scope, project, list, before);
  return `Updated: ${text}`;
}

export async function removeMemory(os: WithFiles, scope: MemoryScope, project: string, text: string): Promise<string> {
  const before = await readMemory(os, scope, project);
  const list = entries(before);
  const i = find(list, text);
  const [gone] = list.splice(i, 1);
  await write(os, scope, project, list, before);
  return `Forgot: ${gone}`;
}
