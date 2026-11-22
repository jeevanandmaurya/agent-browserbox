import type { KernelCore } from '@/kernel/kernel';
import { join } from '@/kernel/vfs/path';
import { C } from '@/shell/ansi';
import type { Command, CommandContext } from '@/shell/shell';

/** `--name value`, `--name=value`, bare flags and positional arguments. */
function args(list: string[]): { opt: Map<string, string | true>; rest: string[] } {
  const opt = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) rest.push(a);
    else if (m[2] !== undefined) opt.set(m[1]!, m[2]);
    else if (list[i + 1] !== undefined && !list[i + 1]!.startsWith('-') && !['private', 'public', 'draft', 'yes'].includes(m[1]!)) opt.set(m[1]!, list[++i]!);
    else opt.set(m[1]!, true);
  }
  return { opt, rest };
}
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);
const kernel = (ctx: CommandContext) => ctx.os as unknown as KernelCore;
const say = (ctx: CommandContext) => (m: string) => ctx.out(`${C.dim}${m}${C.reset}\n`);

export const ghCommand: Command = {
  name: 'gh',
  summary: 'GitHub: sign in, create and clone repositories, push a folder, open pull requests',
  usage: 'gh auth login|status|logout · gh repo create <name> [--public] · gh repo clone <owner/repo> [dir] · gh push [dir] [--repo owner/name] [--branch b] [-m msg] · gh pr create --head <branch> --title <t> [--body b] [--base main] [--repo owner/name]',
  async run(ctx) {
    const os = kernel(ctx);
    const pub = await import('../publish');
    const { opt, rest } = args(ctx.args);
    const [a = 'help', b, c] = rest;
    if (a === 'auth') {
      if (b === 'login') {
        if (!ctx.tty) throw new Error('gh auth login needs a terminal; or add the token in Settings → Accounts');
        ctx.out('Create a fine-grained token at https://github.com/settings/personal-access-tokens\nwith Contents, Pull requests, Pages and Administration (read and write) for your repositories.\n');
        const t = (await ctx.tty.readLine('GitHub token (hidden): ', { secret: true }))?.trim();
        if (!t) return 1;
        const me = await new (await import('../publish/github')).GitHub(t).user();
        await os.secrets.set(pub.TOKENS.github, t);
        return ctx.out(`${C.green}✓${C.reset} signed in as ${me.login}; the token is stored encrypted\n`);
      }
      if (b === 'logout') {
        await os.secrets.delete(pub.TOKENS.github);
        return ctx.out('signed out of GitHub\n');
      }
      const me = await (await pub.github(os)).user();
      return ctx.out(`signed in to GitHub as ${C.bold}${me.login}${C.reset}${me.name ? ` (${me.name})` : ''}\n`);
    }
    if (a === 'repo' && b === 'create') {
      if (!c) throw new Error('usage: gh repo create <name> [--public] [--description text]');
      const gh = await pub.github(os);
      const r = await gh.createRepo(c.includes('/') ? c.split('/')[1]! : c, { private: !opt.has('public'), description: str(opt.get('description')), org: c.includes('/') ? c.split('/')[0] : undefined });
      return ctx.out(`created ${r.full_name}: ${r.html_url}\n`);
    }
    if (a === 'repo' && b === 'clone') {
      if (!c) throw new Error('usage: gh repo clone <owner/repo> [dir]');
      ctx.out((await pub.cloneRepo(os, c, rest[3] ? ctx.path(rest[3]) : null, ctx.shell.cwd, { branch: str(opt.get('branch')) }, say(ctx))) + '\n');
      return;
    }
    if (a === 'push') {
      const dir = ctx.path(b ?? '.');
      ctx.out((await pub.pushFolder(os, dir, { repo: str(opt.get('repo')), branch: str(opt.get('branch')), message: str(opt.get('m') ?? opt.get('message')), private: !opt.has('public') }, say(ctx))) + '\n');
      return;
    }
    if (a === 'pr' && b === 'create') {
      const gh = await pub.github(os);
      const repo = await pub.repoName(gh, str(opt.get('repo')) ?? pub.linksFor(os, ctx.shell.cwd).github?.repo ?? '');
      const head = str(opt.get('head'));
      const title = str(opt.get('title'));
      if (!repo.includes('/') || !head || !title) throw new Error('usage: gh pr create --head <branch> --title <title> [--body text] [--base main] [--repo owner/name] [--draft]');
      const pr = await gh.createPr(repo, { head, title, base: str(opt.get('base')), body: str(opt.get('body')), draft: opt.has('draft') });
      return ctx.out(`opened pull request #${pr.number}: ${pr.html_url}\n`);
    }
    ctx.out(`${ghCommand.usage!.split(' · ').join('\n')}\n${C.dim}Uses GitHub's REST API, which works from the browser (git's own protocol does not). A push is one commit with the folder's current files.${C.reset}\n`);
    return a === 'help' ? 0 : 1;
  },
};

export const deployCommand: Command = {
  name: 'deploy',
  summary: 'build a project for production and publish it to Netlify, Vercel or GitHub Pages',
  usage: 'deploy [dir] --to netlify|vercel|github-pages [--name site-name] [--repo owner/name]',
  async run(ctx) {
    const pub = await import('../publish');
    const { opt, rest } = args(ctx.args);
    const to = str(opt.get('to') ?? opt.get('target'));
    if (to && !pub.DEPLOY_TARGETS.includes(to as never)) throw new Error(`--to must be one of: ${pub.DEPLOY_TARGETS.join(', ')}`);
    const r = await pub.deployFolder(kernel(ctx), ctx.path(rest[0] ?? '.'), { target: to as never, name: str(opt.get('name')), repo: str(opt.get('repo')) }, say(ctx));
    ctx.out(`\n  ${C.green}${C.bold}live${C.reset}  ${C.cyan}${r.url}${C.reset}  ${C.dim}(${r.target}, ${r.files} files)${C.reset}\n${r.note ? `${C.yellow}${r.note.trim()}${C.reset}\n` : ''}`);
  },
};

