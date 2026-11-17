import type { Kernel } from '@/kernel/api';
import { AGENT_HOME } from '@/kernel/paths';
import { parseFrontmatter, parseList } from './frontmatter';

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
  enabled: boolean;
}

export const EXT_DIRS: Record<ExtKind, string> = { skill: `${AGENT_HOME}/skills`, agent: `${AGENT_HOME}/agents`, command: `${AGENT_HOME}/commands` };
export const DISABLED_KEY = 'ext.disabled';
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const extId = (e: Pick<Extension, 'kind' | 'name'>) => `${e.kind}:${e.name}`;
export const validName = (name: string) => NAME.test(name);

export function setEnabled(os: Kernel, e: Pick<Extension, 'kind' | 'name'>, on: boolean): void {
  const off = new Set(os.settings.get<string[]>(DISABLED_KEY, []));
  if (on) off.delete(extId(e));
  else off.add(extId(e));
  os.settings.set(DISABLED_KEY, [...off]);
}

export async function loadExtensions(os: Kernel, kind: ExtKind): Promise<Extension[]> {
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
      return { kind, name, description: meta.description ?? body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 160) ?? '', path, dir: skill ? e.path : root, body, tools: parseList(meta.tools), enabled: !off.has(`${kind}:${name}`) };
    }),
  );
  return out.filter((e): e is Extension => e !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** Starter content for a new extension file. */
export function template(kind: ExtKind, name: string): string {
  if (kind === 'skill') return `---\nname: ${name}\ndescription: When to use this skill, in one sentence.\n---\n\n# ${name}\n\nStep-by-step instructions for the agent. Keep supporting files (templates, scripts, examples) in this folder and refer to them by name.\n`;
  if (kind === 'agent') return `---\nname: ${name}\ndescription: What this agent is for, in one sentence.\ntools: read_file, list_dir, glob, grep\n---\n\nYou are a focused sub-agent. Describe its role, how it should work, and what its final report must contain.\n`;
  return `---\ndescription: What this command does.\n---\n\nThe prompt sent to the agent when you type /${name}. Use $ARGUMENTS where the text after the command should go.\n`;
}

/** Example extensions written on first run so the folders are not empty. */
export const SEED: Array<[string, string]> = [
  [
    `${EXT_DIRS.skill}/web-page/SKILL.md`,
    `---\nname: web-page\ndescription: Build a self-contained web page, chart or small interactive tool and show it in the preview.\n---\n\n# Building a web page\n\n1. Write one complete HTML file in the working directory. Inline the CSS and JavaScript; do not depend on CDNs, because the preview may be offline.\n2. Use system fonts, a readable type scale and enough contrast; make it work at 380px wide.\n3. Draw charts with inline SVG or \`<canvas>\`.\n4. Show it with show_html using the file path, so the user can also open and edit the file.\n5. Say where the file is saved.\n`,
  ],
  [
    `${EXT_DIRS.skill}/data-analysis/SKILL.md`,
    `---\nname: data-analysis\ndescription: Explore, clean and summarise a CSV or JSON file, with numbers checked by running code.\n---\n\n# Analysing data\n\n1. Look before computing: read the first lines of the file and report its shape and columns.\n2. Do the arithmetic in code (run_python with pandas when the Python pack is installed, otherwise run_js) — never estimate figures by eye.\n3. State how missing or malformed values were handled.\n4. Report the findings first, then the method. If a chart helps, build it as an HTML page and show it.\n5. Save derived files next to the source and name them in the answer.\n`,
  ],
  [
    `${EXT_DIRS.agent}/explorer.md`,
    `---\nname: explorer\ndescription: Read-only investigator for searching and summarising many files without changing anything.\ntools: read_file, list_dir, glob, grep\n---\n\nYou investigate a question by reading files. You cannot modify anything. Search broadly first (glob, grep), then read only what matters. Finish with a short report: the answer, the evidence as file paths with line numbers, and anything you could not determine.\n`,
  ],
  [`${EXT_DIRS.command}/explain.md`, `---\ndescription: Explain a file or folder in plain language.\n---\n\nExplain $ARGUMENTS in plain language: what it is for, how it is organised, and anything surprising. Read the relevant files first.\n`],
];
