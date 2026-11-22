import { describe, expect, it } from 'vitest';
import { mayConnect, siteOf } from '@/sdk/origin-policy';

const RT = 'https://jeevanandmaurya.github.io';

describe('which pages may use the runtime', () => {
  it('serves other sites (their storage is partitioned)', () => {
    expect(mayConnect('https://myapp.com', RT, [])).toBe(true);
    expect(mayConnect('https://someone.github.io', RT, [])).toBe(true);
    expect(mayConnect('https://app.vercel.app', RT, [])).toBe(true);
  });
  it('refuses same-site pages unless listed (they would share files and keys)', () => {
    expect(mayConnect('https://a.example.com', 'https://box.example.com', [])).toBe(false);
    expect(mayConnect('https://a.example.com', 'https://box.example.com', ['https://a.example.com'])).toBe(true);
  });
  it('refuses plain http from the internet, allows loopback for development', () => {
    expect(mayConnect('http://myapp.com', RT, [])).toBe(false);
    expect(mayConnect('http://localhost:5173', 'http://127.0.0.1:4173', [])).toBe(true);
    expect(mayConnect('http://localhost:5173', RT, [])).toBe(true);
  });
  it('treats unknown multi-part suffixes as same-site (refuses rather than exposes)', () => {
    expect(siteOf('a.b.co.uk')).toBe('b.co.uk');
    expect(mayConnect('https://x.gov.in', 'https://y.gov.in', [])).toBe(false);
    expect(mayConnect('nonsense', RT, [])).toBe(false);
  });
});
