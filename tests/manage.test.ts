import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AgentOs } from '../packages/agent/src/host/os';
import { chatsCommand, projectCommand } from '../packages/agent/src/manage';
import { saveSession } from '../packages/agent/src/session';
import { pathIn, type AgentCommand } from '../packages/agent/src/commands';
import { plainText } from '../packages/runtime/src/shell/ansi';
import { kernelBox } from './helpers/kernel-box';
import { registerCommands } from '../packages/runtime/src/shell/index';
import { Shell } from '../packages/runtime/src/shell/shell';

async function setup() {
  const { kernel, box } = await kernelBox();
  const os = await AgentOs.create(box, { seed: false });
  const run = async (cmd: AgentCommand, line: string, answer?: string) => {
    let out = '';
    let code: number | void = 0;
    try {
      code = await cmd.run({
        os,
        args: line.split(' ').filter(Boolean),
        stdin: '',
        cwd: '/home/agent',
        path: pathIn('/home/agent'),
        signal: new AbortController().signal,
        out: (t) => (out += t),
        err: (t) => (out += t),
        tty: answer === undefined ? undefined : { readLine: async () => answer, interactive: true },
      });
    } catch (e) {
      out += `ERROR ${(e as Error).message}`;
      code = 1;
    }
    return { out: plainText(out), code };
  };
  return { kernel, os, run };
}

describe('project and chats commands', () => {
  it('lists, creates, renames, uses and shows projects; deleting needs a person who says yes', async () => {
    const { os, run } = await setup();
    expect((await run(projectCommand, 'new Tip calculator')).out).toContain('created Tip calculator (tip-calculator)');
    expect((await run(projectCommand, 'list')).out).toMatch(/general[\s\S]*tip-calculator/);
    expect((await run(projectCommand, 'rename tip-calculator Tips')).out).toContain('renamed to Tips');
    await run(projectCommand, 'use tip-calculator');
    expect(os.settings.get('agent.project.last', '')).toBe('tip-calculator');
    expect((await run(projectCommand, 'show')).out).toContain('Tips (tip-calculator)');
    await run(projectCommand, 'knowledge tip-calculator add notes.md');
    expect((await run(projectCommand, 'knowledge tip-calculator')).out).toContain('notes.md');
    // The agent (no person at a terminal) cannot delete; a person can, after saying yes.
    expect((await run(projectCommand, 'delete tip-calculator')).out).toContain('only a person');
    expect((await run(projectCommand, 'delete tip-calculator', 'n')).out).toContain('Not deleted');
    expect((await run(projectCommand, 'delete tip-calculator', 'y')).out).toContain('deleted Tips');
    expect(os.settings.get('agent.project.last', '')).toBe('general');
  });

  it('lists, searches, shows and exports chats; deleting needs a person', async () => {
    const { os, run } = await setup();
    const msg = (role: 'user' | 'assistant', text: string) => ({ role, content: [{ type: 'text' as const, text }] });
    await saveSession(os, { id: 'chat-1', title: 'Sales report', updated: 1, project: 'general', messages: [], transcript: [msg('user', 'make a sales report'), msg('assistant', 'Best month was July.')], todos: [] } as never);
    await saveSession(os, { id: 'chat-2', title: 'Tip calculator', updated: 2, project: 'general', messages: [], transcript: [msg('user', 'tip calc'), msg('assistant', 'Done.')], todos: [] } as never);
    expect((await run(chatsCommand, 'list')).out).toMatch(/chat-2[\s\S]*chat-1/);
    const found = await run(chatsCommand, 'search july');
    expect(found.out).toContain('chat-1');
    expect(found.out).not.toContain('chat-2');
    expect((await run(chatsCommand, 'show chat-1')).out).toContain('**Agent:** Best month was July.');
    await run(chatsCommand, 'export chat-1 report.md');
    expect(await os.fs.readText('/home/agent/report.md')).toContain('# Sales report');
    expect((await run(chatsCommand, 'delete chat-1')).out).toContain('only a person');
    expect((await run(chatsCommand, 'delete chat-1', 'yes')).out).toContain('deleted');
    expect((await run(chatsCommand, 'list')).out).not.toContain('chat-1');
  });
});

describe('help', () => {
  it('lists commands under sections, and one section or one command on request', async () => {
    const { kernel } = await setup();
    const sh = registerCommands(new Shell(kernel, {}));
    let out = '';
    await sh.run('help', { out: (t) => (out += t), err: (t) => (out += t) });
    const text = plainText(out);
    for (const s of ['Files', 'Text and data', 'Running code', 'Web projects', 'Packages', 'Devices', 'You and BrowserBox', 'System']) expect(text).toContain(s);
    expect(text.indexOf('Files')).toBeLessThan(text.indexOf('  ls'));
    expect(text.indexOf('System')).toBeLessThan(text.indexOf('  ps'));
    out = '';
    await sh.run('help files', { out: (t) => (out += t), err: (t) => (out += t) });
    expect(plainText(out)).toContain('  ls');
    expect(plainText(out)).not.toContain('  ps ');
    out = '';
    await sh.run('help serial', { out: (t) => (out += t), err: (t) => (out += t) });
    expect(plainText(out)).toMatch(/serial — [\s\S]*usage:/);
  });
});
