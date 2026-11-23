import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { KernelCore } from '../packages/runtime/src/kernel/kernel';
import { MemFs } from '../packages/runtime/src/kernel/vfs/memfs';
import { listProfiles } from '../packages/runtime/src/kernel/profiles';
import type { ShellAction } from '../packages/runtime/src/kernel/types';
import { registerCommands } from '../packages/runtime/src/shell/index';
import { plainText } from '../packages/runtime/src/shell/ansi';
import { Shell, type Tty } from '../packages/runtime/src/shell/shell';

function terminal(kernel: KernelCore, answers: string[] = [], person = true) {
  const actions: ShellAction[] = [];
  const tty: Tty = { readLine: async () => answers.shift() ?? null, clear: () => undefined, action: (a) => actions.push(a), interactive: person };
  const shell = registerCommands(new Shell(kernel, { tty }));
  const run = async (line: string) => {
    let out = '';
    const code = await shell.run(line, { out: (t) => (out += t), err: (t) => (out += t) });
    return { code, out: plainText(out) };
  };
  return { run, actions };
}

const kernel = () => {
  const k = new KernelCore();
  k.fs.mount('/', new MemFs());
  k.fs.markReady();
  return k;
};

describe('profile commands', () => {
  it('lets a person create, switch, rename, set a password, sign out and delete', async () => {
    const k = kernel();
    const t = terminal(k, ['pass1234', 'pass1234']);
    expect((await t.run('profile')).out).toMatch(/Default .*no password/);
    expect((await t.run('profile new Ana Lima')).out).toMatch(/Created Ana Lima/);
    expect((await t.run('profile list')).out).toMatch(/\* Default[\s\S]*Ana Lima/);
    expect((await t.run('profile switch ana lima')).code).toBe(0);
    expect(t.actions.at(-1)).toMatchObject({ kind: 'profile' });
    expect((await t.run('profile rename Jeevan')).out).toMatch(/now Jeevan/);
    expect((await t.run('passwd')).out).toMatch(/Password set/);
    expect(await k.secrets.status()).toBe('unlocked');
    expect((await t.run('signout')).out).toMatch(/Signed out/);
    expect(await k.secrets.status()).toBe('locked');
    expect((await t.run('profile delete Jeevan')).out).toMatch(/using: switch/);
    const d = terminal(k, ['nope']);
    expect((await d.run('profile delete "Ana Lima"')).out).toMatch(/Not deleted/);
    const ok = terminal(k, ['ana lima']);
    expect((await ok.run('profile delete "Ana Lima"')).out).toMatch(/Deleted Ana Lima/);
    expect((await listProfiles()).map((p) => p.name)).toEqual(['Jeevan']);
  });

  it('closes the terminal on exit', async () => {
    const t = terminal(kernel());
    expect((await t.run('exit 3')).code).toBe(3);
    expect(t.actions).toEqual([{ kind: 'exit', code: 3 }]);
  });

  it('never lets a program or the agent change profiles', async () => {
    const k = kernel();
    const agent = terminal(k, [], false);
    expect((await agent.run('profile')).code).toBe(0);
    for (const line of ['profile new X', 'profile switch Jeevan', 'profile rename X', 'profile delete Jeevan', 'passwd', 'signout', 'logout']) {
      const r = await agent.run(line);
      expect(r.code, line).toBe(1);
      expect(r.out, line).toMatch(/must be typed by a person/);
    }
    expect(agent.actions).toEqual([]);
  });
});
