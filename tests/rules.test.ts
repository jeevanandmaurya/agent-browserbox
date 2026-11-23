import { describe, expect, it } from 'vitest';
import { decide, matches, splitCommand, type PermRule } from '../packages/agent/src/rules';

const R = (scope: PermRule['scope'], pattern: string, action: PermRule['action']): PermRule => ({ scope, pattern, action });

describe('permission rules', () => {
  it('splits command lines outside quotes and spots substitutions', () => {
    expect(splitCommand('git add . && git commit -m "a; b" | cat').parts).toEqual(['git add .', 'git commit -m "a; b"', 'cat']);
    expect(splitCommand('echo $(rm x)').unsafe).toBe(true);
    expect(splitCommand("echo '$(fine)'").unsafe).toBe(false);
    expect(splitCommand('a || b & c\nd').parts).toEqual(['a', 'b', 'c', 'd']);
  });

  it('matches globs, and `cmd *` also matches the bare command', () => {
    expect(matches('git *', 'git', 'shell')).toBe(true);
    expect(matches('git *', 'git  push  origin', 'shell')).toBe(true);
    expect(matches('git *', 'gitk', 'shell')).toBe(false);
    expect(matches('/home/user/secret/*', '/home/user/secret/a/b.txt', 'path')).toBe(true);
    expect(matches('deploy?', 'deploy', 'tool')).toBe(false);
  });

  it('lets deny beat ask and ask beat allow', () => {
    const rules = [R('shell', '*', 'allow'), R('shell', 'curl *', 'ask'), R('shell', 'curl *evil*', 'deny')];
    expect(decide(rules, 'shell', { command: 'curl https://evil.test' })?.action).toBe('deny');
    expect(decide(rules, 'shell', { command: 'curl https://ok.test' })?.action).toBe('ask');
    expect(decide(rules, 'shell', { command: 'ls' })?.action).toBe('allow');
  });

  it('allows a command line only when every part is allowed', () => {
    const rules = [R('shell', 'git *', 'allow')];
    expect(decide(rules, 'shell', { command: 'git status && git diff' })?.action).toBe('allow');
    expect(decide(rules, 'shell', { command: 'git status && rm x' })).toBeNull();
    expect(decide(rules, 'shell', { command: 'git log $(rm x)' })).toBeNull();
    expect(decide([R('shell', 'rm *', 'deny')], 'shell', { command: 'git status; rm -rf /' })?.action).toBe('deny');
  });

  it('checks paths (resolved) and URLs, and names tools', () => {
    const resolve = (p: string) => (p.startsWith('/') ? p : `/home/agent/${p}`);
    const rules = [R('path', '/home/agent/*', 'allow'), R('path', '/home/user/.ssh*', 'deny'), R('url', 'https://api.github.com/*', 'allow'), R('tool', 'deploy', 'ask')];
    expect(decide(rules, 'write_file', { path: 'notes.md' }, resolve)?.action).toBe('allow');
    expect(decide(rules, 'move_path', { from: 'a', to: '/home/user/.ssh/id' }, resolve)?.action).toBe('deny');
    expect(decide(rules, 'move_path', { from: 'a', to: '/tmp/b' }, resolve)).toBeNull();
    expect(decide(rules, 'http_fetch', { url: 'https://api.github.com/user' })?.action).toBe('allow');
    expect(decide(rules, 'deploy', { path: 'site' }, resolve)?.action).toBe('ask');
    expect(decide([], 'shell', { command: 'ls' })).toBeNull();
  });
});
