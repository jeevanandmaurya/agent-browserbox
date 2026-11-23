import { describe, expect, it } from 'vitest';
import { compareVersions, parseDep, sha256, validatePackage } from '../packages/runtime/src/kernel/packages';

const ok = { id: 'jq', version: '1.7.1', kind: 'wasm', summary: 'JSON', files: [{ path: 'jq.wasm', url: 'https://x.test/jq.wasm', sha256: 'a'.repeat(64) }], commands: { jq: { run: 'jq.wasm' } } };

describe('package descriptions', () => {
  it('accepts a complete one and refuses what is missing or unsafe', () => {
    expect(validatePackage(ok).depends).toEqual([]);
    expect(() => validatePackage({ ...ok, id: 'Bad Id' })).toThrow(/id must be/);
    expect(() => validatePackage({ ...ok, kind: 'exe' })).toThrow(/kind must be/);
    expect(() => validatePackage({ ...ok, files: [{ ...ok.files[0], sha256: 'nope' }] })).toThrow(/needs a sha256/);
    expect(() => validatePackage({ ...ok, files: [{ ...ok.files[0], path: '../x' }] })).toThrow(/file path/);
    expect(() => validatePackage({ ...ok, files: [{ ...ok.files[0], url: 'file:///etc/passwd' }] })).toThrow(/file url/);
    expect(() => validatePackage({ ...ok, commands: { jq: { run: 'other.wasm' } } })).toThrow(/not one of its files/);
  });

  it('compares versions numerically and reads dependencies', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.3')).toBe(-1);
    expect(parseDep('jshello>=1.0')).toEqual({ id: 'jshello', min: '1.0' });
    expect(parseDep('lua')).toEqual({ id: 'lua', min: undefined });
    expect(parseDep('Bad!')).toBeNull();
  });

  it('hashes with sha256', async () => {
    expect(await sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
