import type { Kernel } from '@/kernel/api';
import { AGENT_HOME } from '@/kernel/paths';
import type { TodoItem } from './tools/index';
import type { Checkpoint } from './checkpoints';
import type { FileDiff } from './diff';
import type { Msg } from './types';

const DIR = `${AGENT_HOME}/.sessions`;

export interface SessionFile {
  id: string;
  title: string;
  updated: number;
  /** The model's context (a summary after compaction). */
  messages: Msg[];
  /** The full conversation for display; absent in files saved before compaction existed. */
  transcript?: Msg[];
  todos: TodoItem[];
  /** Files as they were before each turn changed them (for undo). */
  checkpoints?: Checkpoint[];
  /** What each file tool call changed, by tool call id. */
  diffs?: Record<string, FileDiff>;
}

export interface SessionInfo {
  id: string;
  title: string;
  updated: number;
}

/** Sessions are plain JSON files in the agent's home, so they survive reloads and are inspectable. */
export async function saveSession(os: Kernel, s: SessionFile): Promise<void> {
  await os.fs.writeFile(`${DIR}/${s.id}.json`, JSON.stringify(s));
}

export async function loadSession(os: Kernel, id: string): Promise<SessionFile> {
  return JSON.parse(await os.fs.readText(`${DIR}/${id}.json`)) as SessionFile;
}

export async function deleteSession(os: Kernel, id: string): Promise<void> {
  await os.fs.rm(`${DIR}/${id}.json`).catch(() => undefined);
}

export async function listSessions(os: Kernel): Promise<SessionInfo[]> {
  const entries = await os.fs.readdir(DIR).catch(() => []);
  const infos = await Promise.all(
    entries
      .filter((e) => e.name.endsWith('.json'))
      .map(async (e): Promise<SessionInfo | null> => {
        try {
          // Titles live at the start of the file; parsing the whole transcript just for a list is fine at this scale.
          const s = JSON.parse(await os.fs.readText(e.path)) as SessionFile;
          return { id: s.id, title: s.title, updated: s.updated };
        } catch {
          return null;
        }
      }),
  );
  return infos.filter((i): i is SessionInfo => i !== null).sort((a, b) => b.updated - a.updated);
}

export function titleFrom(messages: Msg[]): string {
  const first = messages.find((m) => m.role === 'user')?.content.find((b) => b.type === 'text');
  // Only what the person typed: not attached file contents or hidden mode instructions.
  const raw = first?.type === 'text' ? first.text.replace(/<file path="[^"]*"[^>]*?(?:\/>|>[\s\S]*?<\/file>)/g, '').replace(/<mode>[\s\S]*?<\/mode>/g, '') : '';
  const text = raw.trim().replace(/\s+/g, ' ');
  return text.length > 60 ? text.slice(0, 57) + '…' : text || 'New session';
}
