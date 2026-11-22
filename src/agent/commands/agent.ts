import type { PermDecision } from '@/kernel/perms';
import type { Command, CommandContext } from '@/shell/shell';
import { C } from '@/shell/ansi';

/**
 * The CLI face of the agent. `agent "task"` runs one task; plain `agent`
 * starts an interactive session in the terminal. The agent module is loaded
 * on first use so the shell itself stays small.
 */
export const agentCommand: Command = {
  name: 'agent',
  summary: 'talk to the AI agent from the command line',
  usage: 'agent ["task"]   — no argument starts an interactive session (/exit to leave, /new to reset)',
  async run(ctx: CommandContext) {
    const { Agent } = await import('../agent');
    const { describeModel, loadConfig } = await import('../config');
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
      { ppid: ctx.shell.ppid },
    );
    agent.shell.cwd = ctx.shell.cwd;
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
