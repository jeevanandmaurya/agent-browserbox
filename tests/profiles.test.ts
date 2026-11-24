import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { dbName, fromSearch, fromWorkerName, toSearch, workerName } from '../packages/runtime/src/kernel/instance';
import { createProfile, DEFAULT_PROFILE, deleteProfile, kernelOf, lastProfile, listProfiles, setLastProfile, updateProfile } from '../packages/runtime/src/kernel/profiles';
import { Secrets, SecretsLockedError } from '../packages/runtime/src/kernel/secrets';
import { BrowserSecrets, SecretsLockedError as AgentLocked } from '../packages/agent/src/host/secrets';

describe('profile kernels', () => {
  it('give each profile its own worker, URL and stores; the first keeps the original ones', () => {
    const p = kernelOf('pabc');
    expect(workerName(p)).toBe('bbx-kernel:profile:pabc');
    expect(fromWorkerName(workerName(p))).toEqual(p);
    expect(fromSearch(toSearch(p))).toEqual(p);
    expect(dbName('bbx-secrets', p)).toBe('bbx-secrets:profile:pabc');
    const first = kernelOf(DEFAULT_PROFILE);
    expect([workerName(first), toSearch(first), dbName('bbx-secrets', first)]).toEqual(['bbx-kernel', '', 'bbx-secrets']);
    expect(() => fromSearch('?profile=../x')).toThrow(/invalid profile/);
  });
});

describe('the profile list', () => {
  it('starts with Default, adds, renames, remembers the last one and deletes', async () => {
    expect((await listProfiles()).map((p) => p.name)).toEqual(['Default']);
    const ana = await createProfile('  Ana   Lima ');
    expect(ana.name).toBe('Ana Lima');
    await updateProfile(DEFAULT_PROFILE, { name: 'Me' });
    expect((await listProfiles()).map((p) => p.name)).toEqual(['Me', 'Ana Lima']);
    expect(await lastProfile()).toBe(DEFAULT_PROFILE);
    await setLastProfile(ana.id);
    expect(await lastProfile()).toBe(ana.id);
    await deleteProfile(ana.id);
    expect(await lastProfile()).toBe(DEFAULT_PROFILE);
    expect((await listProfiles()).map((p) => p.id)).toEqual([DEFAULT_PROFILE]);
    await expect(deleteProfile(DEFAULT_PROFILE)).rejects.toThrow(/cannot be deleted/);
    await expect(createProfile('  ')).rejects.toThrow(/needs a name/);
  });
});

describe('password-locked keys', () => {
  it('sets a password, signs out and in, changes and removes it, keeping every key', async () => {
    const s = new Secrets('test-secrets-1');
    await s.set('api.key:api.anthropic.com', 'sk-ant-1');
    await s.set('github.token', 'ghp');
    expect(await s.status()).toBe('open');

    await s.setPassword('correct horse');
    expect(await s.status()).toBe('unlocked');
    expect(await s.get('api.key:api.anthropic.com')).toBe('sk-ant-1');

    await s.lock();
    expect(await s.status()).toBe('locked');
    await expect(s.get('github.token')).rejects.toBeInstanceOf(SecretsLockedError);
    await expect(s.set('x', 'y')).rejects.toBeInstanceOf(SecretsLockedError);
    // A second reader of the same store (another worker) sees the same state.
    await expect(new Secrets('test-secrets-1').get('github.token')).rejects.toBeInstanceOf(SecretsLockedError);

    expect(await s.unlock('wrong')).toBe(false);
    expect(await s.status()).toBe('locked');
    expect(await s.unlock('correct horse')).toBe(true);
    expect(await new Secrets('test-secrets-1').get('github.token')).toBe('ghp');

    await s.setPassword('battery staple');
    await s.lock();
    expect(await s.unlock('correct horse')).toBe(false);
    expect(await s.unlock('battery staple')).toBe(true);

    await s.setPassword(null);
    expect(await s.status()).toBe('open');
    await s.lock();
    expect(await s.get('api.key:api.anthropic.com')).toBe('sk-ant-1');
  });
});

describe('passkeys unlock a password-locked profile', () => {
  it('adds one with the password, signs in with its PRF output, refuses a wrong one, and is removed by a password change', async () => {
    const s = new Secrets('test-secrets-pk');
    await s.set('api.key:x', 'sk-pk');
    const input = crypto.getRandomValues(new Uint8Array(32));
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const id = 'Y3JlZGVudGlhbC1pZA';
    await expect(s.addPasskey('pw', { id, label: 'Laptop', input, prf })).rejects.toThrow(/Set a password first/);

    await s.setPassword('pw');
    expect(await s.addPasskey('wrong', { id, label: 'Laptop', input, prf })).toBe(false);
    expect(await s.addPasskey('pw', { id, label: 'Laptop', input, prf })).toBe(true);
    const listed = await s.passkeys();
    expect(listed.map((k) => [k.id, k.label])).toEqual([[id, 'Laptop']]);
    expect(Object.keys(listed[0]!).sort()).toEqual(['created', 'id', 'input', 'label']);

    await s.lock();
    expect(await s.unlockWithPasskey(id, crypto.getRandomValues(new Uint8Array(32)))).toBe(false);
    expect(await s.unlockWithPasskey('other', prf)).toBe(false);
    expect(await s.status()).toBe('locked');
    expect(await s.unlockWithPasskey(id, prf)).toBe(true);
    expect(await s.status()).toBe('unlocked');
    expect(await s.get('api.key:x')).toBe('sk-pk');
    // The agent's reader sees the session a passkey opened, like a password's.
    expect(await new BrowserSecrets('test-secrets-pk').get('api.key:x')).toBe('sk-pk');

    // A new password means a new data key: old passkeys would unwrap the wrong one.
    await s.setPassword('pw2');
    expect(await s.passkeys()).toEqual([]);
    await s.lock();
    expect(await s.unlockWithPasskey(id, prf)).toBe(false);
    expect(await s.unlock('pw2')).toBe(true);

    expect(await s.addPasskey('pw2', { id, label: 'Again', input, prf })).toBe(true);
    await s.removePasskey(id);
    expect(await s.passkeys()).toEqual([]);
  });
});

describe('the agent reads the same locked store', () => {
  it('sees keys while signed in, is refused when signed out, and never makes a new key then', async () => {
    const kernel = new Secrets('test-secrets-2');
    await kernel.set('api.key:api.openai.com', 'sk-1');
    await kernel.setPassword('pw');
    const agent = new BrowserSecrets('test-secrets-2');
    expect(await agent.get('api.key:api.openai.com')).toBe('sk-1');
    await kernel.lock();
    await expect(agent.get('api.key:api.openai.com')).rejects.toBeInstanceOf(AgentLocked);
    await expect(agent.set('new', 'v')).rejects.toBeInstanceOf(AgentLocked);
    expect(await kernel.unlock('pw')).toBe(true);
    expect(await agent.get('api.key:api.openai.com')).toBe('sk-1');
  });
});
