import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_URL, VERSION } from '../packages/sdk/src/index';

const version = (p: string) => JSON.parse(readFileSync(new URL(`../packages/${p}/package.json`, import.meta.url), 'utf8')).version as string;

describe('SDK and runtime versions', () => {
  it('are released together with one version', () => {
    expect(version('sdk')).toBe(version('runtime'));
  });

  it("match the SDK's VERSION, which pins its default runtime", () => {
    expect(VERSION).toBe(version('sdk'));
    expect(DEFAULT_RUNTIME_URL).toMatch(new RegExp(`/runtime/${VERSION.replace(/\./g, '\\.')}/$`));
  });

  it('is what the kernel reports', () => {
    expect(__BBX_RUNTIME_VERSION__).toBe(version('runtime'));
  });

  it('has a changelog section for the current version', () => {
    expect(readFileSync(new URL('../packages/sdk/CHANGELOG.md', import.meta.url), 'utf8')).toContain(`\n## ${VERSION}\n`);
  });
});
