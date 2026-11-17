import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript Worker, no types
import worker from '../relay/worker.js';
import { relayed, unreachable } from '../src/agent/config';

const env = { ALLOWED_HOSTS: 'ollama.com', ALLOWED_ORIGINS: 'https://me.github.io' };
const call = (url: string, init: RequestInit & { origin?: string } = {}) =>
  worker.fetch(new Request(url, { ...init, headers: { origin: init.origin ?? 'https://me.github.io', ...(init.headers as Record<string, string>) } }), env) as Promise<Response>;

afterEach(() => vi.unstubAllGlobals());

describe('relay', () => {
  it('forwards to allowed hosts with CORS headers and the key', async () => {
    const seen: Array<{ url: string; auth: string | null; cookie: string | null }> = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url: String(url), auth: h.get('authorization'), cookie: h.get('cookie') });
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } });
    });
    const res = await call('https://relay.dev/https://ollama.com/v1/chat/completions', { method: 'POST', body: '{}', headers: { authorization: 'Bearer k', cookie: 'secret=1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://me.github.io');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(seen).toEqual([{ url: 'https://ollama.com/v1/chat/completions', auth: 'Bearer k', cookie: null }]);
  });
  it('is not an open proxy', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('must not be called')));
    expect((await call('https://relay.dev/https://evil.example/x')).status).toBe(403);
    expect((await call('https://relay.dev/https://ollama.com/v1/models', { origin: 'https://other.site' })).status).toBe(403);
    expect((await call('https://relay.dev/http://ollama.com/v1/models')).status).toBe(403);
  });
  it('answers the preflight', async () => {
    const res = await call('https://relay.dev/https://ollama.com/v1/chat/completions', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });
});

describe('relay URLs and errors', () => {
  it('prefixes the full URL', () => {
    expect(relayed('https://ollama.com/v1/models', 'https://r.workers.dev/')).toBe('https://r.workers.dev/https://ollama.com/v1/models');
    expect(relayed('https://ollama.com/v1/models', '')).toBe('https://ollama.com/v1/models');
  });
  it('explains CORS failures, with Ollama-specific advice', () => {
    expect(unreachable('https://ollama.com/v1', 'openai')).toMatch(/ollama\.com did not accept a request from this page.*relay.*ollama signin/s);
    expect(unreachable('http://localhost:11434/v1', 'local')).toMatch(/OLLAMA_ORIGINS/);
  });
});
