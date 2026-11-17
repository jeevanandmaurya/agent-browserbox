import { DEFAULT_CONFIG, SECRET, probeOpenAi, saveConfig } from '@/agent/config';
import { C } from '../ansi';
import type { Command, Tty } from '../shell';
import { defaultPackages, installPackages } from './pkg';

export const SETUP_DONE = 'setup.done';

/**
 * First-boot setup: at most two questions, both skippable. Everything else
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
    await installPackages(ctx, defaultPackages().filter((id) => !os.packages.isInstalled(id)));
    if (!os.settings.keys().includes('ui.theme')) os.settings.set('ui.theme', 'system');
    os.settings.set(SETUP_DONE, true);
    out(`${C.dim}done · python: pkg install python · run setup again any time${C.reset}\n`);
  },
};
