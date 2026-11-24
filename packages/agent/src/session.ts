import type { Kernel, WithFiles, WithSettings } from './host/os.js';
import { AGENT_HOME } from './host/paths.js';
import type { TodoItem } from './tools/index.js';
import type { Checkpoint } from './checkpoints.js';
import type { FileDiff } from './diff.js';
import type { Msg } from './types.js';

const DIR = `${AGENT_HOME}/.sessions`;

export interface SessionFile {
  id: string;
  title: string;
  updated: number;
  /** The project it belongs to (absent: General, from before projects). */
  project?: string;
  /** The model's context (a summary after compaction). */
  messages: Msg[];
  /** The full conversation for display; absent in files saved before compaction existed. */
  transcript?: Msg[];
  todos: TodoItem[];
  /** Files as they were before each turn changed them (for undo). */
  checkpoints?: Checkpoint[];
  /** What each file tool call changed, by tool call id. */
  diffs?: Record<string, FileDiff>;
  /** What each sub-agent did, by its spawn_agent call id. */
  subagents?: Record<string, Msg[]>;
  /** Works on its own copy of the project folder (see isolation.ts). */
  isolated?: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
  updated: number;
  project: string;
}

/**
 * The list of sessions, kept next to them so listing does not read every
 * transcript. Rebuilt from the files when it is missing or unreadable.
 */
const INDEX = `${DIR}/index.json`;
const GENERAL_ID = 'general';

async function readIndex(os: WithFiles): Promise<SessionInfo[] | null> {
  try {
    const list = JSON.parse(await os.fs.readText(INDEX)) as unknown;
    return Array.isArray(list) ? (list as SessionInfo[]) : null;
  } catch {
    return null;
  }
}

async function rebuildIndex(os: WithFiles): Promise<SessionInfo[]> {
  const entries = await os.fs.readdir(DIR).catch(() => []);
  const infos = await Promise.all(
    entries
      .filter((e) => e.name.endsWith('.json') && e.name !== 'index.json')
      .map(async (e): Promise<SessionInfo | null> => {
        try {
          const s = JSON.parse(await os.fs.readText(e.path)) as SessionFile;
          return { id: s.id, title: s.title, updated: s.updated, project: s.project ?? GENERAL_ID };
        } catch {
          return null;
        }
      }),
  );
  const list = infos.filter((i): i is SessionInfo => i !== null);
  await os.fs.writeFile(INDEX, JSON.stringify(list)).catch(() => undefined);
  return list;
}

async function updateIndex(os: WithFiles, change: (list: SessionInfo[]) => SessionInfo[]): Promise<void> {
  const list = (await readIndex(os)) ?? (await rebuildIndex(os));
  await os.fs.writeFile(INDEX, JSON.stringify(change(list)));
}

/** Sessions are plain JSON files in the agent's home, so they survive reloads and are inspectable. */
export async function saveSession(os: WithFiles, s: SessionFile): Promise<void> {
  await os.fs.writeFile(`${DIR}/${s.id}.json`, JSON.stringify(s));
  const info: SessionInfo = { id: s.id, title: s.title, updated: s.updated, project: s.project ?? GENERAL_ID };
  await updateIndex(os, (list) => [...list.filter((i) => i.id !== s.id), info]).catch(() => undefined);
}

export async function loadSession(os: WithFiles, id: string): Promise<SessionFile> {
  return JSON.parse(await os.fs.readText(`${DIR}/${id}.json`)) as SessionFile;
}

/** Where an isolated chat sees its copy of the project folder. */
export const workFolder = (id: string) => `/work/${id}`;

/** Where an isolated chat keeps its changes until they are applied: deleted with the chat. */
export const workStore = (id: string) => `${DIR}/${id}/work`;

/** Files attached to a chat (uploads, pasted pictures, voice notes): kept with it, deleted with it. */
export const attachmentsDir = (id: string) => `${DIR}/${id}/files`;

export async function deleteSession(os: WithFiles, id: string): Promise<void> {
  await os.fs.rm(`${DIR}/${id}.json`).catch(() => undefined);
  await os.fs.rm(`${DIR}/${id}`, { recursive: true }).catch(() => undefined);
  await updateIndex(os, (list) => list.filter((i) => i.id !== id)).catch(() => undefined);
}

/** Sessions, newest first; only one project's when `project` is given. */
export async function listSessions(os: WithFiles, project?: string): Promise<SessionInfo[]> {
  const list = (await readIndex(os)) ?? (await rebuildIndex(os));
  return list.filter((i) => !project || (i.project ?? GENERAL_ID) === project).sort((a, b) => b.updated - a.updated);
}

export function titleFrom(messages: Msg[]): string {
  const first = messages.find((m) => m.role === 'user')?.content.find((b) => b.type === 'text');
  // Only what the person typed: not attached file contents or hidden mode instructions.
  const raw = first?.type === 'text' ? first.text.replace(/<file path="[^"]*"[^>]*?(?:\/>|>[\s\S]*?<\/file>)/g, '').replace(/<mode>[\s\S]*?<\/mode>/g, '') : '';
  const text = raw.trim().replace(/\s+/g, ' ');
  return text.length > 60 ? text.slice(0, 57) + '…' : text || 'New session';
}
