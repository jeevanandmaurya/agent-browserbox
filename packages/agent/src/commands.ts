import { Agent } from './agent.js';
import { DEFAULT_CONFIG, describeModel, loadConfig, probeOpenAi, saveConfig, SECRET } from './config.js';
import { C } from './host/ansi.js';
import { Shell, type AgentOs } from './host/os.js';
import { resolve } from './host/path.js';
import type { PermDecision } from './host/perms.js';

/**
 * The agent's terminal commands: `setup` (first-boot model setup), `agent`
 * (talk to the agent in a terminal), `gh` and `deploy`. An app contributes
 * them to its box's shell (see the BrowserBox app's agent worker), which runs
 * them here with this context.
 */
export interface Tty {
  readLine(prompt: string, opts?: { secret?: boolean }): Promise<string | null>;
}

export interface CommandContext {
  os: AgentOs;
  args: string[];
  stdin: string;
  /** The shell's working folder. */
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  signal: AbortSignal;
  /** Present when a terminal is attached. */
  tty?: Tty;
  /** Resolves a path against `cwd`. */
  path(p: string): string;
}

export interface AgentCommand {
  name: string;
  summary: string;
  usage?: string;
  run(ctx: CommandContext): Promise<number | void>;
}

type Command = AgentCommand;

/** Builds a command context's `path` from its working folder. */
export const pathIn = (cwd: string) => (p: string) => resolve(cwd, p);

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
const say = (ctx: CommandContext) => (m: string) => ctx.out(`${C.dim}${m}${C.reset}\n`);


export const SETUP_DONE = 'setup.done';

/**
 * First-boot setup: a name, then a model (at most two more questions); all skippable. Everything else
 * gets a default that can be changed later in Settings.
 */
export const setupCommand: Command = {
  name: 'setup',
  summary: 'connect a model and install the default packages',
  usage: 'setup  |  setup --defaults   (no questions)',
  async run(ctx) {
    const { os, out, tty } = ctx;
    const ask = async (t: Tty, prompt: string, secret = false) => {
      const answer = await t.readLine(prompt, { secret });
      if (answer === null) throw new Error('setup cancelled');
      return answer.trim();
    };

    if (tty && !ctx.args.includes('--defaults')) {
      // There is no account, so this is the only place BrowserBox learns what to call you.
      const current = os.settings.get<string>('user.name', '');
      const name = (await ask(tty, `Your name ${C.dim}(${current ? `${current} · ` : ''}for greetings · Enter to skip)${C.reset}: `)).slice(0, 40);
      if (name) {
        os.settings.set('user.name', name);
        out(`${C.green}✓${C.reset} Hi, ${name}\n`);
      }
      const key = await ask(tty, `Anthropic API key ${C.dim}(hidden · Enter to skip)${C.reset}: `, true);
      if (key) {
        await os.secrets.set(SECRET.anthropic, key);
        saveConfig(os, { provider: 'anthropic' });
        out(`${C.green}✓${C.reset} Claude Opus 5.5 · key stored encrypted\n`);
      } else {
        for (;;) {
          const url = await ask(tty, `Local model server ${C.dim}(e.g. ${DEFAULT_CONFIG.localBaseUrl} · Enter to skip)${C.reset}: `);
          if (!url) {
            out(`${C.dim}no model yet: add one later in Settings → Model${C.reset}\n`);
            break;
          }
          try {
            const models = await probeOpenAi(url, null);
            if (!models.length) throw new Error(`${url} has no models loaded`);
            let model = models[0]!;
            if (models.length > 1) {
              models.forEach((m, i) => out(`  ${i + 1}  ${m}\n`));
              model = models[Number(await ask(tty, `model ${C.dim}[1]${C.reset}: `)) - 1] ?? models[0]!;
            }
            saveConfig(os, { provider: 'local', localBaseUrl: url, localModel: model });
            out(`${C.green}✓${C.reset} ${model} on ${url}\n`);
            break;
          } catch (err) {
            out(`${C.yellow}${(err as Error).message}${C.reset}\n`);
          }
        }
      }
    }

    // Small packages are installed without asking; Python (11 MB) only on request.
    const sh = new Shell(os, { cwd: ctx.cwd });
    try {
      await sh.run('pkg install --defaults', { out, err: ctx.err, signal: ctx.signal });
    } finally {
      sh.close();
    }
    await os.packages.refresh();
    if (!os.settings.keys().includes('ui.theme')) os.settings.set('ui.theme', 'system');
    os.settings.set(SETUP_DONE, true);
    out(`${C.dim}done · python: pkg install python · run setup again any time${C.reset}\n`);
  },
};

export const agentCommand: Command = {
  name: 'agent',
  summary: 'talk to the AI agent from the command line',
  usage: 'agent ["task"]   — no argument starts an interactive session (/exit to leave, /new to reset)',
  async run(ctx: CommandContext) {
    const { out, tty } = ctx;
    let inText = false;
    let failed = false;
    const endText = () => {
      if (inText) out('\n');
      inText = false;
    };

    const agent = new Agent(
      ctx.os,
      {
        onEvent(e) {
          if (e.type === 'text') {
            out(e.delta);
            inText = true;
          } else if (e.type === 'tool_start') {
            endText();
            out(`${C.cyan}▸ ${e.name}${C.reset} ${C.dim}${e.summary.split('\n')[0]!.slice(0, 140)}${C.reset}\n`);
          } else if (e.type === 'tool_end') {
            const first = e.result.split('\n').find((l) => l.trim()) ?? '';
            out(`  ${e.isError ? `${C.red}✗` : `${C.green}✓`}${C.reset} ${C.dim}${first.slice(0, 140)}${e.result.length > first.length ? ' …' : ''}${C.reset}\n`);
          } else if (e.type === 'status' && e.text) {
            endText();
            out(`${C.dim}${e.text}${C.reset}\n`);
          } else if (e.type === 'note') {
            endText();
            out(`${C.yellow}${e.text}${C.reset}\n`);
          } else if (e.type === 'error') {
            endText();
            failed = true;
            ctx.err(`${C.red}${e.message}${C.reset}\n`);
          } else if (e.type === 'done') endText();
        },
        async ask(question, options) {
          endText();
          if (!tty) return 'No terminal is attached, so the user cannot answer. Use your best judgement.';
          out(`${C.yellow}?${C.reset} ${question}${options?.length ? ` ${C.dim}(${options.join(' / ')})${C.reset}` : ''}\n`);
          return (await tty.readLine('answer> ')) ?? '(no answer)';
        },
        // In a terminal, ask for permission inline rather than with a dialog.
        prompter: tty
          ? async (req): Promise<PermDecision> => {
              endText();
              out(`${C.yellow}Allow ${req.title}?${C.reset} ${C.dim}${req.detail.split('\n')[0]!.slice(0, 160)}${C.reset}\n`);
              const a = ((await tty.readLine('[y]es / [a]lways / [n]o > ')) ?? 'n').trim().toLowerCase();
              return a.startsWith('a') ? 'always' : a.startsWith('y') ? 'once' : 'deny';
            }
          : undefined,
      },
    );
    agent.shell.cwd = ctx.cwd;
    const abort = () => agent.stop();
    ctx.signal.addEventListener('abort', abort);

    try {
      const task = ctx.args.join(' ').trim() || ctx.stdin.trim();
      if (task) {
        await agent.send(task);
        return failed ? 1 : 0;
      }
      if (!tty) throw new Error('usage: agent "task"');
      out(`${C.bold}BrowserBox agent${C.reset} ${C.dim}${describeModel(loadConfig(ctx.os))} — /exit to leave, /new for a fresh session${C.reset}\n`);
      for (;;) {
        const line = await tty.readLine(`${C.magenta}agent>${C.reset} `);
        if (line === null || line.trim() === '/exit' || line.trim() === '/quit') break;
        if (line.trim() === '/new') {
          agent.reset();
          out(`${C.dim}Started a new session.${C.reset}\n`);
        } else if (line.trim()) await agent.send(line);
        if (ctx.signal.aborted) break;
      }
      return 0;
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      agent.dispose();
    }
  },
};

export const ghCommand: Command = {
  name: 'gh',
  summary: 'GitHub: sign in, create and clone repositories, push a folder, open pull requests',
  usage: 'gh auth login|status|logout · gh repo create <name> [--public] · gh repo clone <owner/repo> [dir] · gh push [dir] [--repo owner/name] [--branch b] [-m msg] · gh pr create --head <branch> --title <t> [--body b] [--base main] [--repo owner/name]',
  async run(ctx) {
    const os = ctx.os;
    const pub = await import('./publish/index.js');
    const { opt, rest } = args(ctx.args);
    const [a = 'help', b, c] = rest;
    if (a === 'auth') {
      if (b === 'login') {
        if (!ctx.tty) throw new Error('gh auth login needs a terminal; or add the token in Settings → Accounts');
        ctx.out('Create a fine-grained token at https://github.com/settings/personal-access-tokens\nwith Contents, Pull requests, Pages and Administration (read and write) for your repositories.\n');
        const t = (await ctx.tty.readLine('GitHub token (hidden): ', { secret: true }))?.trim();
        if (!t) return 1;
        const me = await new (await import('./publish/github.js')).GitHub(t).user();
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
      ctx.out((await pub.cloneRepo(os, c, rest[3] ? ctx.path(rest[3]) : null, ctx.cwd, { branch: str(opt.get('branch')) }, say(ctx))) + '\n');
      return;
    }
    if (a === 'push') {
      const dir = ctx.path(b ?? '.');
      ctx.out((await pub.pushFolder(os, dir, { repo: str(opt.get('repo')), branch: str(opt.get('branch')), message: str(opt.get('m') ?? opt.get('message')), private: !opt.has('public') }, say(ctx))) + '\n');
      return;
    }
    if (a === 'pr' && b === 'create') {
      const gh = await pub.github(os);
      const repo = await pub.repoName(gh, str(opt.get('repo')) ?? pub.linksFor(os, ctx.cwd).github?.repo ?? '');
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
    const pub = await import('./publish/index.js');
    const { opt, rest } = args(ctx.args);
    const to = str(opt.get('to') ?? opt.get('target'));
    if (to && !pub.DEPLOY_TARGETS.includes(to as never)) throw new Error(`--to must be one of: ${pub.DEPLOY_TARGETS.join(', ')}`);
    const r = await pub.deployFolder(ctx.os, ctx.path(rest[0] ?? '.'), { target: to as never, name: str(opt.get('name')), repo: str(opt.get('repo')) }, say(ctx));
    ctx.out(`\n  ${C.green}${C.bold}live${C.reset}  ${C.cyan}${r.url}${C.reset}  ${C.dim}(${r.target}, ${r.files} files)${C.reset}\n${r.note ? `${C.yellow}${r.note.trim()}${C.reset}\n` : ''}`);
  },
};


export const AGENT_COMMANDS: AgentCommand[] = [setupCommand, agentCommand, ghCommand, deployCommand];
