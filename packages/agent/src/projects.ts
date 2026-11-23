import type { WithFiles, WithSettings } from './host/os.js';
import { AGENT_HOME, HOME } from './host/paths.js';
import { isInside } from './host/path.js';

/**
 * Projects: separate workspaces, each with its own folder (where the agent
 * works and reads AGENTS.md), chats, memory and pinned knowledge files.
 * "General" is the original workspace, /home/agent, so every chat made before
 * projects belongs to it. The agent's own records (chats, memory) never go in
 * a project's folder, which may be a git repository the user pushes.
 */
export interface Project {
  id: string;
  name: string;
  /** Where the agent works: its working folder and the area it may change freely. */
  folder: string;
  created: number;
  /** A default model for this project's chats (an API model id; '' = the main one). */
  model?: string;
  /** Files always put in the agent's context (up to a budget); paths, absolute or relative to the folder. */
  knowledge?: string[];
}

export const PROJECTS_KEY = 'agent.projects';
export const GENERAL_ID = 'general';
export const GENERAL: Project = { id: GENERAL_ID, name: 'General', folder: AGENT_HOME, created: 0 };

/** Where projects go by default. */
export const PROJECTS_DIR = `${HOME}/Projects`;

/** Folders that cannot be a project's: the agent's records, the system's own. */
const RESERVED = [`${AGENT_HOME}/.sessions`, `${AGENT_HOME}/.memory`, '/proc', '/tmp'];

function valid(p: unknown): p is Project {
  return !!p && typeof p === 'object' && typeof (p as Project).id === 'string' && typeof (p as Project).name === 'string' && typeof (p as Project).folder === 'string' && (p as Project).id !== GENERAL_ID;
}

/** Every project, General first. */
export function loadProjects(os: WithSettings): Project[] {
  const stored = os.settings.get<unknown>(PROJECTS_KEY, []);
  const list = Array.isArray(stored) ? stored.filter(valid) : [];
  return [GENERAL, ...list.sort((a, b) => a.created - b.created)];
}

/** A project by id; General when it is unknown (deleted, or from an older version). */
export function getProject(os: WithSettings, id: string | null | undefined): Project {
  return loadProjects(os).find((p) => p.id === id) ?? GENERAL;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'project';

/** The folder a new project named `name` gets by default. */
export const defaultFolder = (name: string) => `${PROJECTS_DIR}/${name.trim().replace(/[/\\\0]/g, '-').replace(/\s+/g, ' ') || 'Project'}`;

function checkFolder(folder: string): string {
  const f = folder.trim().replace(/\/+$/, '');
  if (!f.startsWith('/')) throw new Error('The folder must be an absolute path, such as /home/user/Projects/site');
  if (f === '/' || RESERVED.some((r) => isInside(r, f))) throw new Error(`${f} cannot be a project folder`);
  return f;
}

/** Makes a project (and its folder). */
export async function createProject(os: WithSettings & WithFiles & { fs: { mkdir(p: string): Promise<void> } }, opts: { name: string; folder?: string; model?: string }): Promise<Project> {
  const name = opts.name.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw new Error('A project needs a name');
  const folder = checkFolder(opts.folder?.trim() || defaultFolder(name));
  const taken = new Set(loadProjects(os).map((p) => p.id));
  let id = slug(name);
  for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`;
  const project: Project = { id, name, folder, created: Date.now(), ...(opts.model ? { model: opts.model } : {}) };
  await os.fs.mkdir(folder);
  os.settings.set(PROJECTS_KEY, [...loadProjects(os).slice(1), project]);
  return project;
}

/** Changes a project's name, model or knowledge files (General keeps its name and folder). */
export function updateProject(os: WithSettings, id: string, patch: Partial<Pick<Project, 'name' | 'model' | 'knowledge'>>): Project {
  if (id === GENERAL_ID) throw new Error('General cannot be changed');
  const list = loadProjects(os).slice(1);
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`No project ${id}`);
  const next = { ...list[i]!, ...patch, ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 60) || list[i]!.name } : {}) };
  list[i] = next;
  os.settings.set(PROJECTS_KEY, list);
  return next;
}

/** Forgets a project. Its chats and memory go with it; its folder only when asked. */
export async function removeProject(os: WithSettings & WithFiles & { fs: { rm(p: string, o?: { recursive?: boolean }): Promise<void> } }, id: string, opts: { deleteFolder?: boolean } = {}): Promise<void> {
  if (id === GENERAL_ID) throw new Error('General cannot be deleted');
  const project = loadProjects(os).find((p) => p.id === id);
  if (!project) return;
  os.settings.set(PROJECTS_KEY, loadProjects(os).slice(1).filter((p) => p.id !== id));
  const { deleteSession, listSessions } = await import('./session.js');
  for (const s of await listSessions(os, id)) await deleteSession(os, s.id);
  await os.fs.rm(`${AGENT_HOME}/.memory/${id}.md`).catch(() => undefined);
  if (opts.deleteFolder) await os.fs.rm(project.folder, { recursive: true }).catch(() => undefined);
}
