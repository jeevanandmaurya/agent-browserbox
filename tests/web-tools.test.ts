import { afterEach, describe, expect, it, vi } from 'vitest';
import { webTools } from '../packages/agent/src/tools/web';
import type { ToolContext } from '../packages/agent/src/tools/types';

const search = webTools.find((t) => t.name === 'web_search')!;
const fetchPage = webTools.find((t) => t.name === 'web_fetch')!;

function ctx(settings: Record<string, unknown>, secrets: Record<string, string>): ToolContext {
  return {
    os: { settings: { get: (k: string, d: unknown) => (k === 'agent.config' ? settings : d) }, secrets: { get: async (n: string) => secrets[n] ?? null } },
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' }, ...init });

afterEach(() => vi.unstubAllGlobals());

describe('web tools in the browser', () => {
  it('auto: the first service with a key (Tavily), with the key sent to it only', async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => (calls.push([String(url), init]), reply({ results: [{ title: 'RH', url: 'https://x.test/rh', content: 'About the zeta zeros' }] })));
    const out = await search.run({ query: 'riemann', max_results: 3 }, ctx({}, { 'search.tavily': 'tvly-1', 'search.serper': 's-1' }));
    expect(out).toContain('Results from Tavily for “riemann”');
    expect(out).toContain('1. RH\n   https://x.test/rh\n   About the zeta zeros');
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('https://api.tavily.com/search');
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer tvly-1');
    expect(JSON.parse(calls[0]![1].body as string)).toMatchObject({ query: 'riemann', max_results: 3 });
  });

  it('Serper: Google results with its answer box first', async () => {
    vi.stubGlobal('fetch', async () => reply({ answerBox: { title: 'RH', answer: 'Unproven' }, organic: [{ title: 'Wiki', link: 'https://w.test', snippet: 's' }] }));
    const out = await search.run({ query: 'riemann' }, ctx({ webSearch: 'serper' }, { 'search.serper': 'k' }));
    expect(out).toMatch(/Results from Serper[^\n]*\n\n1\. Answer: RH[\s\S]*2\. Wiki/);
  });

  it('a chosen service without a key says where to add one; a refused key is explained', async () => {
    await expect(search.run({ query: 'x' }, ctx({ webSearch: 'jina' }, {}))).rejects.toThrow(/no key is saved.*Settings → Model → Web search/);
    vi.stubGlobal('fetch', async () => reply('nope', { status: 401 }));
    await expect(search.run({ query: 'x' }, ctx({ webSearch: 'tavily' }, { 'search.tavily': 'bad' }))).rejects.toThrow(/refused the key \(HTTP 401\)/);
  });

  it('no key: Wikipedia, with the snippet markup removed and a note to the model', async () => {
    vi.stubGlobal('fetch', async (url: string) => (expect(url).toContain('en.wikipedia.org/w/api.php'), reply({ query: { search: [{ title: 'Riemann hypothesis', snippet: 'the <span class="searchmatch">Riemann</span> &quot;zeta&quot;' }] } })));
    const out = await search.run({ query: 'riemann' }, ctx({}, {}));
    expect(out).toContain('1. Riemann hypothesis\n   https://en.wikipedia.org/wiki/Riemann_hypothesis\n   the Riemann "zeta"');
    expect(out).toContain('Only Wikipedia is searched');
  });

  it('web_fetch reads a page directly, else through Jina Reader, unless that is off', async () => {
    vi.stubGlobal('fetch', async () => reply('<html><title>T</title><body><h1>Hello</h1><script>x()</script></body></html>'));
    expect(await fetchPage.run({ url: 'https://a.test/' }, ctx({}, {}))).toMatch(/^https:\/\/a\.test\/\n\n[\s\S]*Hello/);
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      if (!String(url).startsWith('https://r.jina.ai/')) throw new TypeError('Failed to fetch');
      return reply('Title: B\n\nBody text', { headers: { 'content-type': 'text/plain' } });
    });
    expect(await fetchPage.run({ url: 'https://b.test/page' }, ctx({}, {}))).toContain('(read through Jina Reader)\n\nTitle: B');
    expect(urls).toEqual(['https://b.test/page', 'https://r.jina.ai/https://b.test/page']);
    await expect(fetchPage.run({ url: 'https://b.test/page' }, ctx({ jinaReader: false }, {}))).rejects.toThrow(/Jina Reader is turned off/);
  });
});
