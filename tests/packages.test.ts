import { describe, expect, it } from 'vitest';
import { bundleJs, compareVersions, parseDep, sha256, validatePackage } from '../packages/runtime/src/kernel/packages';

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

describe('JavaScript packages', () => {
  const js = {
    id: 'tool',
    version: '1.0.0',
    kind: 'js',
    summary: '',
    files: [
      { path: 'lib.js', url: 'https://x.test/lib.js', sha256: 'a'.repeat(64) },
      { path: 'main.js', text: 'print(1)', sha256: 'b'.repeat(64) },
    ],
    commands: { tool: { run: 'main.js', load: ['lib.js'] } },
  };

  it('accepts inline wrapper files and load lists, and checks them', () => {
    expect(validatePackage(js).commands.tool!.load).toEqual(['lib.js']);
    expect(() => validatePackage({ ...js, commands: { tool: { run: 'main.js', load: ['nope.js'] } } })).toThrow(/loads a file/);
    expect(() => validatePackage({ ...js, kind: 'wasm' })).toThrow(/only JavaScript packages load/);
    expect(() => validatePackage({ ...js, files: [js.files[0], { ...js.files[1], url: 'https://x.test/m.js' }] })).toThrow(/both url and text/);
  });

  it('bundles UMD, CommonJS and global libraries for require()', async () => {
    const umd = `(function (g, f) { typeof exports === 'object' && typeof module !== 'undefined' ? f(exports) : f((g.umdLib = {})); })(this, function (e) { e.twice = (n) => n * 2; });`;
    const cjs = `module.exports = { name: 'cjs' };`;
    const code = bundleJs([['lib/umd.js', umd], ['cjs.js', cjs]], `return [require('lib/umd.js').twice(21), require('./cjs.js').name, (() => { try { require('x'); } catch (e) { return e.message; } })()];`);
    const AsyncFunction = (async () => {}).constructor as new (...a: string[]) => () => Promise<unknown>;
    expect(await new AsyncFunction(code)()).toEqual([42, 'cjs', 'cannot require x']);
  });
});
