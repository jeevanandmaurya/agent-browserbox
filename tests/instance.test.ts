import { describe, expect, it } from 'vitest';
import { APP_KERNEL, dbName, fromSearch, fromWorkerName, toSearch, workerName } from '../packages/runtime/src/kernel/instance';

describe('kernel instances', () => {
  it('round-trips a box through the URL and the worker name', () => {
    for (const k of [{ box: 'a', storage: 'opfs' as const }, { box: 'mem-1_x', storage: 'memory' as const }, APP_KERNEL]) {
      expect(fromSearch(toSearch(k))).toEqual(k);
      expect(fromWorkerName(workerName(k))).toEqual(k);
    }
  });

  it("keeps the app's kernel and storage names unchanged", () => {
    expect(workerName(APP_KERNEL)).toBe('bbx-kernel');
    expect(dbName('bbx-settings', APP_KERNEL)).toBe('bbx-settings');
  });

  it('gives each box its own databases, and in-memory boxes none', () => {
    expect(dbName('bbx-settings', { box: 'a', storage: 'opfs' })).toBe('bbx-settings:box:a');
    expect(dbName('bbx-secrets', { box: 'a', storage: 'memory' })).toBeNull();
  });

  it('rejects ids that could escape their folder or name', () => {
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'a b', 'a:b']) expect(() => fromSearch(`?box=${encodeURIComponent(bad)}`)).toThrow();
    expect(fromWorkerName('bbx-box:opfs:../x')).toEqual(APP_KERNEL);
  });
});
