import { C } from './host/ansi.js';
import type { AgentCommand, CommandContext } from './commands.js';
import { createProject, GENERAL_ID, getProject, loadProjects, removeProject, updateProject } from './projects.js';
import { deleteSession, listSessions, loadSession, titleFrom, type SessionInfo } from './session.js';
import type { Msg } from './types.js';

/**
 * Terminal commands for what the app's sidebar and settings do with projects
 * and chats, so a person or the agent can do them by typing too. Removing
 * things (a project, a chat) stays with a person at a terminal, who confirms.
 */
const when = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** For deleting: only a person typing in a terminal, after saying yes. */
async function confirmed(ctx: CommandContext, question: string): Promise<boolean> {
  if (!ctx.tty?.interactive) throw new Error('only a person can do that, in a terminal (the agent and scripts cannot)');
  const a = await ctx.tty.readLine(`${question} [y/N] `);
  return /^y(es)?$/i.test(a?.trim() ?? '');
}

function flags(args: string[]): { opt: Map<string, string | true>; rest: string[] } {
  const opt = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) opt.set(k, v);
      else if (args[i + 1] && !args[i + 1]!.startsWith('--') && ['folder', 'project', 'model'].includes(k)) opt.set(k, args[++i]!);
      else opt.set(k, true);
    } else rest.push(a);
  }
  return { opt, rest };
}

export const projectCommand: AgentCommand = {
  name: 'project',
  section: 'ai',
  summary: 'projects: list, show, new, rename, use, knowledge, delete',
  usage: `project [list]
project show [id]
project new <name> [--folder /path] [--model id]
project rename <id> <new name>
project use <id>                 the project new chats and windows start in
project knowledge <id> [add|remove <path>…]
project delete <id> [--folder]   a person only; --folder deletes its folder too`,
  async run(ctx) {
    const { os, out } = ctx;
    const { opt, rest } = flags(ctx.args);
    const [verb = 'list', id, ...more] = rest;
    const last = os.settings.get<string>('agent.project.last', GENERAL_ID);
    const find = (x?: string) => {
      const p = loadProjects(os).find((q) => q.id === x || q.name.toLowerCase() === x?.toLowerCase());
      if (!p) throw new Error(`no project ${x ?? ''} (project list)`);
      return p;
    };
    if (verb === 'list') {
      const counts = new Map<string, number>();
      for (const s of await listSessions(os)) counts.set(s.project ?? GENERAL_ID, (counts.get(s.project ?? GENERAL_ID) ?? 0) + 1);
      for (const p of loadProjects(os)) out(`${p.id === last ? `${C.green}*${C.reset}` : ' '} ${C.bold}${p.id.padEnd(18)}${C.reset} ${p.name.padEnd(22)} ${C.dim}${p.folder} · ${counts.get(p.id) ?? 0} chats${C.reset}\n`);
      return;
    }
    if (verb === 'show') {
      const p = id ? find(id) : getProject(os, last);
      const agentsMd = await os.fs.readText(`${p.folder}/AGENTS.md`).catch(() => '');
      out(`${C.bold}${p.name}${C.reset} (${p.id})\nfolder     ${p.folder}\ncreated    ${p.created ? when(p.created) : '—'}\nmodel      ${p.model || 'the main one'}\nknowledge  ${p.knowledge?.join(', ') || 'none'}\nchats      ${(await listSessions(os, p.id)).length}\ninstructions ${agentsMd ? `${p.folder}/AGENTS.md (${agentsMd.split('\n').length} lines)` : `none (write ${p.folder}/AGENTS.md)`}\n`);
      return;
    }
    if (verb === 'new') {
      const name = [id, ...more].filter(Boolean).join(' ');
      const p = await createProject(os as never, { name, folder: typeof opt.get('folder') === 'string' ? (opt.get('folder') as string) : undefined, model: typeof opt.get('model') === 'string' ? (opt.get('model') as string) : undefined });
      out(`created ${C.bold}${p.name}${C.reset} (${p.id}) in ${p.folder}\n`);
      return;
    }
    if (verb === 'rename') {
      const p = updateProject(os, find(id).id, { name: more.join(' ') });
      out(`renamed to ${p.name}\n`);
      return;
    }
    if (verb === 'use') {
      const p = find(id);
      os.settings.set('agent.project.last', p.id);
      out(`new chats and new windows start in ${C.bold}${p.name}${C.reset} (an open window keeps its project; switch it in the sidebar)\n`);
      return;
    }
    if (verb === 'knowledge') {
      const p = find(id);
      const [op, ...paths] = more;
      if (!op) return void out(`${(p.knowledge ?? []).join('\n') || 'no knowledge files'}\n`);
      const list = new Set(p.knowledge ?? []);
      for (const x of paths) op === 'remove' ? list.delete(x) : list.add(x);
      updateProject(os, p.id, { knowledge: [...list] });
      out(`${p.name}: ${[...list].join(', ') || 'no knowledge files'}\n`);
      return;
    }
    if (verb === 'delete') {
      const p = find(id);
      if (!(await confirmed(ctx, `Delete project ${p.name}, its chats and memory${opt.has('folder') ? `, and the folder ${p.folder}` : ''}?`))) return void out('Not deleted.\n');
      await removeProject(os as never, p.id, { deleteFolder: opt.has('folder') });
      if (last === p.id) os.settings.set('agent.project.last', GENERAL_ID);
      out(`deleted ${p.name}\n`);
      return;
    }
    throw new Error(`unknown: project ${verb} (help project)`);
  },
};

/** A chat's words, as Markdown. */
function asMarkdown(title: string, messages: Msg[]): string {
  const parts = [`# ${title}\n`];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim() && !b.text.startsWith('<hook-')) parts.push(`**${m.role === 'user' ? 'You' : 'Agent'}:** ${b.text.trim()}\n`);
      else if (b.type === 'tool_use') parts.push(`> ${b.name} ${JSON.stringify(b.input).slice(0, 200)}\n`);
    }
  }
  return parts.join('\n');
}

export const chatsCommand: AgentCommand = {
  name: 'chats',
  section: 'ai',
  summary: 'saved chats: list, search, show, export, delete',
  usage: `chats [list] [--project id] [--all]
chats search <words>             in titles and messages
chats show <id>                  what was said
chats export <id> [file.md]      as Markdown (to the terminal, or a file)
chats delete <id>                a person only`,
  async run(ctx) {
    const { os, out } = ctx;
    const { opt, rest } = flags(ctx.args);
    const [verb = 'list', ...more] = rest;
    const project = typeof opt.get('project') === 'string' ? (opt.get('project') as string) : undefined;
    const names = new Map(loadProjects(os).map((p) => [p.id, p.name]));
    const line = (s: SessionInfo) => out(`${C.cyan}${s.id}${C.reset}  ${s.title.slice(0, 60).padEnd(60)}  ${C.dim}${names.get(s.project ?? GENERAL_ID) ?? s.project} · ${when(s.updated)}${C.reset}\n`);
    const find = async (id?: string) => {
      const all = await listSessions(os);
      const s = all.find((x) => x.id === id) ?? all.find((x) => id && x.id.startsWith(id));
      if (!s) throw new Error(`no chat ${id ?? ''} (chats list)`);
      return s;
    };
    if (verb === 'list') {
      const list = await listSessions(os, project);
      if (!list.length) return void out('No saved chats.\n');
      for (const s of opt.has('all') ? list : list.slice(0, 30)) line(s);
      if (!opt.has('all') && list.length > 30) out(`${C.dim}…and ${list.length - 30} more (--all)${C.reset}\n`);
      return;
    }
    if (verb === 'search') {
      const words = more.join(' ').toLowerCase();
      if (!words) throw new Error('chats search <words>');
      let found = 0;
      for (const s of await listSessions(os, project)) {
        if (ctx.signal.aborted) break;
        if (s.title.toLowerCase().includes(words)) {
          line(s);
          found++;
          continue;
        }
        const file = await loadSession(os, s.id).catch(() => null);
        const hit = (file?.transcript ?? file?.messages ?? []).flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))).find((t) => t.toLowerCase().includes(words));
        if (hit) {
          line(s);
          const at = hit.toLowerCase().indexOf(words);
          out(`    ${C.dim}…${hit.slice(Math.max(0, at - 40), at + words.length + 40).replace(/\s+/g, ' ')}…${C.reset}\n`);
          found++;
        }
      }
      if (!found) out('Nothing found.\n');
      return found ? 0 : 1;
    }
    if (verb === 'show' || verb === 'export') {
      const s = await find(more[0]);
      const file = await loadSession(os, s.id);
      const words = file.transcript ?? file.messages ?? [];
      const md = asMarkdown(s.title || titleFrom(words), words);
      if (verb === 'export' && more[1]) {
        await os.fs.writeFile(ctx.path(more[1]), md);
        return void out(`wrote ${ctx.path(more[1])}\n`);
      }
      out(md.endsWith('\n') ? md : `${md}\n`);
      return;
    }
    if (verb === 'delete') {
      const s = await find(more[0]);
      if (!(await confirmed(ctx, `Delete the chat “${s.title}”?`))) return void out('Not deleted.\n');
      await deleteSession(os, s.id);
      out('deleted\n');
      return;
    }
    throw new Error(`unknown: chats ${verb} (help chats)`);
  },
};
