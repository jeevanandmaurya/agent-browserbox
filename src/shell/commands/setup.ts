import { ANTHROPIC_MODELS, DEFAULT_CONFIG, LOCAL_PRESETS, SECRET, WEBLLM_MODELS, loadConfig, probeOpenAi, saveConfig } from '@/agent/config';
import { PACKAGES } from '@/packages/registry';
import { C } from '../ansi';
import type { Command, CommandContext, Tty } from '../shell';
import { defaultPackages, installPackages } from './pkg';

export const SETUP_DONE = 'setup.done';

async function ask(tty: Tty, out: (t: string) => void, label: string, fallback: string, secret = false): Promise<string> {
  const answer = await tty.readLine(`${label}${fallback ? ` ${C.dim}[${fallback}]${C.reset}` : ''}: `, { secret });
  if (answer === null) throw new Error('setup cancelled');
  void out;
  return answer.trim() || fallback;
}

async function pick<T extends { label: string }>(tty: Tty, out: (t: string) => void, title: string, options: T[], def = 1): Promise<T> {
  out(`\n${C.bold}${title}${C.reset}\n`);
  options.forEach((o, i) => out(`  ${String(i + 1).padStart(2)}  ${o.label}\n`));
  for (;;) {
    const n = Number(await ask(tty, out, 'choice', String(def)));
    const o = options[n - 1];
    if (o) return o;
    out(`${C.yellow}enter a number from 1 to ${options.length}${C.reset}\n`);
  }
}

async function chooseModel(ctx: CommandContext, tty: Tty): Promise<void> {
  const { os, out } = ctx;
  const cfg = loadConfig(os);
  const where = await pick(tty, out, 'Where should the agent’s model run?', [
    { id: 'anthropic', label: `Claude (Anthropic API)        ${C.dim}needs an API key${C.reset}` },
    { id: 'openai', label: `Local server                  ${C.dim}Ollama, LM Studio, llama.cpp, vLLM${C.reset}` },
    { id: 'webllm', label: `In this browser (WebGPU)      ${C.dim}small model, offline after download${C.reset}` },
    { id: 'skip', label: `Decide later` },
  ], ['anthropic', 'openai', 'webllm'].indexOf(cfg.provider) + 1 || 1);

  if (where.id === 'anthropic') {
    const has = await os.secrets.has(SECRET.anthropic);
    const key = await ask(tty, out, `Anthropic API key ${C.dim}(hidden, stored encrypted)${C.reset}`, has ? 'keep current' : 'skip', true);
    if (key !== 'keep current' && key !== 'skip') await os.secrets.set(SECRET.anthropic, key);
    const model = await pick(tty, out, 'Claude model', ANTHROPIC_MODELS.map((m) => ({ id: m.id, label: m.label })), Math.max(1, ANTHROPIC_MODELS.findIndex((m) => m.id === cfg.anthropicModel) + 1));
    saveConfig(os, { provider: 'anthropic', anthropicModel: model.id });
  } else if (where.id === 'openai') {
    out(`${C.dim}${LOCAL_PRESETS.map((p) => `${p.label}: ${p.baseUrl}`).join(' · ')}${C.reset}\n`);
    const baseUrl = await ask(tty, out, 'server URL', cfg.openaiBaseUrl || DEFAULT_CONFIG.openaiBaseUrl);
    let models: string[] = [];
    try {
      models = await probeOpenAi(baseUrl, await os.secrets.get(SECRET.openai));
      out(`${C.green}connected${C.reset} · ${models.length} model${models.length === 1 ? '' : 's'}\n`);
    } catch (err) {
      out(`${C.yellow}${(err as Error).message}${C.reset}\n`);
    }
    const model = models.length ? (await pick(tty, out, 'Model', models.map((m) => ({ id: m, label: m })))).id : await ask(tty, out, 'model name', cfg.openaiModel);
    const window = Number(await ask(tty, out, `context window in tokens ${C.dim}(the size the server runs the model with)${C.reset}`, String(cfg.contextWindow)));
    saveConfig(os, { provider: 'openai', openaiBaseUrl: baseUrl, openaiModel: model, contextWindow: Number.isFinite(window) && window >= 2048 ? window : cfg.contextWindow });
  } else if (where.id === 'webllm') {
    if (!os.hasCap('webgpu')) out(`${C.yellow}this browser has no WebGPU, so the in-browser model will not run here${C.reset}\n`);
    const model = await pick(tty, out, 'Model (downloaded on first use)', WEBLLM_MODELS.map((m) => ({ id: m.id, label: m.label })));
    saveConfig(os, { provider: 'webllm', webllmModel: model.id });
  }
}

export const setupCommand: Command = {
  name: 'setup',
  summary: 'configure the model, permissions, theme and packages',
  usage: 'setup  |  setup --defaults   (install the default packages without asking)',
  async run(ctx) {
    const { os, out, tty } = ctx;
    if (ctx.args.includes('--defaults') || !tty) {
      await installPackages(ctx, defaultPackages().filter((id) => !os.packages.isInstalled(id)));
      os.settings.set(SETUP_DONE, true);
      return;
    }
    out(`${C.bold}BrowserBox setup${C.reset} ${C.dim}— Enter accepts the value in [brackets]; run \`setup\` again any time${C.reset}\n`);
    await chooseModel(ctx, tty);

    out(`\n${C.bold}Permissions${C.reset}\n`);
    const askFirst = await ask(tty, out, 'ask before the agent runs code, uses the network or changes files outside /home/agent? (y/n)', os.perms.mode === 'auto' ? 'n' : 'y');
    os.perms.mode = /^n/i.test(askFirst) ? 'auto' : 'ask';

    out(`\n${C.bold}Theme${C.reset}\n`);
    const theme = await ask(tty, out, 'dark, light or system', os.settings.get('ui.theme', 'dark'));
    if (['dark', 'light', 'system'].includes(theme)) os.settings.set('ui.theme', theme);

    out(`\n${C.bold}Packages${C.reset}\n`);
    for (const p of await os.packages.list()) out(`  ${p.installed ? `${C.green}i${C.reset}` : ' '} ${p.id.padEnd(8)} ${C.dim}${p.summary}${C.reset}\n`);
    const fallback = os.settings.get(SETUP_DONE, false) ? os.packages.installed().join(' ') || 'none' : defaultPackages().join(' ');
    const wanted = (await ask(tty, out, 'install (names separated by spaces, or "none")', fallback)).split(/[\s,]+/).filter((x) => x && x !== 'none');
    const unknown = wanted.filter((id) => !PACKAGES.some((p) => p.id === id));
    if (unknown.length) out(`${C.yellow}skipping unknown: ${unknown.join(', ')}${C.reset}\n`);
    await installPackages(ctx, wanted.filter((id) => !unknown.includes(id) && !os.packages.isInstalled(id)));

    os.settings.set(SETUP_DONE, true);
    out(`\n${C.green}setup complete${C.reset}\n`);
  },
};
