import './style.css';
import type { AppModule } from '@/ui/apps';
import { getProfile } from '@jeevanand/agent-browserbox-runtime/client';
import { PROFILE, switchProfile } from '@/app/boot';
import { Terminal } from '@/ui/terminal';

/** The Terminal app: a Terminal component running an interactive loop on a kernel shell. */
const app: AppModule = {
  async mount(ctx) {
    const { os, root, win, proc } = ctx;
    const shell = await os.shells.open({ cwd: typeof ctx.args.cwd === 'string' ? ctx.args.cwd : undefined, ppid: proc.pid });
    const term = new Terminal({
      cls: 'fill',
      keyBar: true,
      complete: (line) => shell.complete(line),
      history: { load: () => os.settings.get<string[]>('terminal.history', []), save: (lines) => os.settings.set('terminal.history', lines) },
    });
    term.attach(shell);
    root.append(term.el);
    // exit closes this terminal; profile switch opens another profile in this window.
    term.onAction = (a) => (a.kind === 'exit' ? win.close() : void switchProfile(a.id));

    // The prompt names the profile: "jeevan@bbx".
    const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user';
    let user = 'user';
    const showUser = async () => {
      user = slug((await getProfile(await PROFILE).catch(() => null))?.name ?? 'user');
    };
    await showUser();
    ctx.on('settings:change', ({ key }) => key === 'profile.name' && void showUser());

    const prompt = () => {
      const cwd = shell.cwd === shell.home ? '~' : shell.cwd.startsWith(shell.home + '/') ? '~' + shell.cwd.slice(shell.home.length) : shell.cwd;
      return `\x1b[32m${user}@bbx\x1b[0m \x1b[34m${cwd}\x1b[0m ❯ `;
    };
    const exec = async (line: string) => {
      os.procs.update(proc.pid, { state: 'running', detail: line.slice(0, 60) });
      const started = performance.now();
      await term.run(shell, line);
      os.procs.account(proc.pid, performance.now() - started);
      os.procs.update(proc.pid, { state: 'idle', detail: shell.cwd });
      win.setTitle(`Terminal — ${shell.cwd}`);
    };

    term.write(`\x1b[1mBrowserBox ${os.version}\x1b[0m \x1b[2m— type \x1b[0mhelp\x1b[2m for commands, \x1b[0magent\x1b[2m to talk to the AI.\x1b[0m\n`);
    if (typeof ctx.args.command === 'string') {
      term.write(prompt() + ctx.args.command + '\n');
      await exec(ctx.args.command);
    }
    void (async () => {
      while (!proc.signal.aborted) {
        const line = await term.readLine(prompt(), { command: true });
        if (line?.trim()) await exec(line);
      }
    })();
    return () => shell.close();
  },
};
export default app;
