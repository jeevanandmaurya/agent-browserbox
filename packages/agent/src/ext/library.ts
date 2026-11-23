import { SEED_FILES } from './seed.js';
import type { Kernel, WithFiles, WithSettings } from '../host/os.js';
import { AGENT_HOME } from '../host/paths.js';
import { parseFrontmatter, parseList } from './frontmatter.js';

/**
 * Extensions are plain Markdown files in the agent's home, so they are
 * visible, editable and portable:
 *   skills/<name>/SKILL.md   instructions the agent loads when a task matches
 *   agents/<name>.md         a sub-agent persona (prompt + allowed tools)
 *   commands/<name>.md       a prompt template run as /name
 */
export type ExtKind = 'skill' | 'agent' | 'command';

export interface Extension {
  kind: ExtKind;
  name: string;
  description: string;
  /** The Markdown file that defines it. */
  path: string;
  /** Folder holding supporting files (skills only). */
  dir: string;
  body: string;
  /** Tool names this agent may use; empty = all. (agents only) */
  tools: string[];
  /** A model of its own, e.g. a fast one for exploring (agents only; API models). */
  model?: string;
  enabled: boolean;
}

export const EXT_DIRS: Record<ExtKind, string> = { skill: `${AGENT_HOME}/skills`, agent: `${AGENT_HOME}/agents`, command: `${AGENT_HOME}/commands` };
export const DISABLED_KEY = 'ext.disabled';
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const extId = (e: Pick<Extension, 'kind' | 'name'>) => `${e.kind}:${e.name}`;
export const validName = (name: string) => NAME.test(name);

export function setEnabled(os: WithSettings, e: Pick<Extension, 'kind' | 'name'>, on: boolean): void {
  const off = new Set(os.settings.get<string[]>(DISABLED_KEY, []));
  if (on) off.delete(extId(e));
  else off.add(extId(e));
  os.settings.set(DISABLED_KEY, [...off]);
}

export async function loadExtensions(os: WithFiles & WithSettings, kind: ExtKind): Promise<Extension[]> {
  const root = EXT_DIRS[kind];
  const off = new Set(os.settings.get<string[]>(DISABLED_KEY, []));
  const entries = await os.fs.readdir(root).catch(() => []);
  const out = await Promise.all(
    entries.map(async (e): Promise<Extension | null> => {
      const skill = kind === 'skill';
      if (skill ? e.kind !== 'dir' : e.kind !== 'file' || !e.name.endsWith('.md')) return null;
      const name = skill ? e.name : e.name.slice(0, -3);
      const path = skill ? `${e.path}/SKILL.md` : e.path;
      const text = await os.fs.readText(path).catch(() => null);
      if (text === null || !validName(name)) return null;
      const { meta, body } = parseFrontmatter(text);
      return { kind, name, description: meta.description ?? body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 160) ?? '', path, dir: skill ? e.path : root, body, tools: parseList(meta.tools), ...(meta.model ? { model: meta.model.trim() } : {}), enabled: !off.has(`${kind}:${name}`) };
    }),
  );
  return out.filter((e): e is Extension => e !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** Starter content for a new extension file. */
export function template(kind: ExtKind, name: string): string {
  if (kind === 'skill') return `---\nname: ${name}\ndescription: When to use this skill, in one sentence.\n---\n\n# ${name}\n\nStep-by-step instructions for the agent. Keep supporting files (templates, scripts, examples) in this folder and refer to them by name.\n`;
  if (kind === 'agent') return `---\nname: ${name}\ndescription: What this agent is for, in one sentence.\ntools: read_file, list_dir, glob, grep\n# model: claude-haiku-5-5   (optional: a model of its own)\n---\n\nYou are a focused sub-agent. Describe its role, how it should work, and what its final report must contain.\n`;
  return `---\ndescription: What this command does.\n---\n\nThe prompt sent to the agent when you type /${name}. Use $ARGUMENTS where the text after the command should go.\n`;
}

// Example extensions copied into /home/agent on first run, so the folders are
// not empty. They are ordinary files: src/agent/ext/seed/<skills|agents|commands>/…
export const SEED: Array<[string, string]> = Object.entries(SEED_FILES).map(([path, text]) => [`${AGENT_HOME}/${path}`, text]);
