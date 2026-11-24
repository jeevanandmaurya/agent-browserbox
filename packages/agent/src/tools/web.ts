import { loadConfig, SEARCH_SERVICES, type AgentConfig } from '../config.js';
import { htmlToText } from './system.js';
import { clip, obj, tool, type ToolContext, type ToolDef } from './types.js';

/**
 * Web search and page reading for models that have no server-side web tools
 * (Anthropic's API brings its own). They run in the browser, so they can only
 * use services that accept requests from web pages: a search service with the
 * user's key, else Wikipedia; pages directly when the site allows it, else
 * through Jina Reader when the user lets it.
 */
interface Hit {
  title: string;
  url: string;
  snippet: string;
}

type Service = (typeof SEARCH_SERVICES)[number]['id'] | 'wikipedia';

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** The service to use, with its key: the chosen one, or the first with a key ('auto'), else Wikipedia. */
async function serviceFor(tc: ToolContext, cfg: AgentConfig): Promise<{ id: Service; key: string | null; name: string }> {
  const keyOf = (id: string) => tc.os.secrets.get(SEARCH_SERVICES.find((s) => s.id === id)!.secret).catch(() => null);
  const wanted = cfg.webSearch ?? 'auto';
  if (wanted !== 'auto' && wanted !== 'wikipedia' && wanted !== 'off') {
    const key = await keyOf(wanted);
    const s = SEARCH_SERVICES.find((x) => x.id === wanted)!;
    if (!key) throw new Error(`Web search is set to ${s.name}, but no key is saved. Ask the user to add one in Settings → Model → Web search (${s.site}).`);
    return { id: wanted, key, name: s.name };
  }
  if (wanted === 'auto')
    for (const s of SEARCH_SERVICES) {
      const key = await keyOf(s.id);
      if (key) return { id: s.id, key, name: s.name };
    }
  return { id: 'wikipedia', key: null, name: 'Wikipedia' };
}

async function json(res: Response, name: string): Promise<Record<string, unknown>> {
  if (res.status === 401 || res.status === 403) throw new Error(`${name} refused the key (HTTP ${res.status}). Check it in Settings → Model → Web search.`);
  if (res.status === 429) throw new Error(`${name} says too many searches for now (HTTP 429). Wait, or use fewer searches.`);
  if (!res.ok) throw new Error(`${name} answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

async function search(svc: { id: Service; key: string | null; name: string }, query: string, n: number, signal: AbortSignal): Promise<Hit[]> {
  const post = (url: string, headers: Record<string, string>, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal, credentials: 'omit' });
  switch (svc.id) {
    case 'tavily': {
      const d = await json(await post('https://api.tavily.com/search', { authorization: `Bearer ${svc.key}` }, { query, max_results: n, search_depth: 'basic' }), svc.name);
      return ((d.results as Array<Record<string, string>>) ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
    }
    case 'serper': {
      const d = await json(await post('https://google.serper.dev/search', { 'x-api-key': svc.key! }, { q: query, num: n }), svc.name);
      const box = d.answerBox as Record<string, string> | undefined;
      const hits = ((d.organic as Array<Record<string, string>>) ?? []).map((r) => ({ title: r.title ?? '', url: r.link ?? '', snippet: r.snippet ?? '' }));
      return box && (box.answer || box.snippet) ? [{ title: `Answer: ${box.title ?? query}`, url: box.link ?? '', snippet: box.answer ?? box.snippet ?? '' }, ...hits] : hits;
    }
    case 'jina': {
      const res = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, { headers: { authorization: `Bearer ${svc.key}`, accept: 'application/json', 'x-respond-with': 'no-content' }, signal, credentials: 'omit' });
      const d = await json(res, svc.name);
      return ((d.data as Array<Record<string, string>>) ?? []).slice(0, n).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description || (r.content ?? '').slice(0, 400) }));
    }
    default: {
      const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=${n}&srsearch=${encodeURIComponent(query)}`, {
        signal,
        credentials: 'omit',
        // Wikimedia asks API clients to say who they are (a browser cannot set User-Agent; this header is allowed).
        headers: { 'api-user-agent': 'BrowserBox agent (https://github.com/jeevanandmaurya/agent-browserbox)' },
      });
      const d = await json(res, 'Wikipedia');
      const list = ((d.query as { search?: Array<{ title: string; snippet: string }> })?.search ?? []);
      return list.map((r) => ({ title: r.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`, snippet: stripTags(r.snippet) }));
    }
  }
}

export const webTools: ToolDef[] = [
  tool<{ query: string; max_results?: number }>({
    name: 'web_search',
    description:
      'Search the web. Returns titles, addresses and excerpts; read a page with web_fetch. One query per call: for several, make several calls in the same turn (they run together). Without a search service set up by the user it searches Wikipedia only, and says so.',
    input_schema: obj({ query: { type: 'string' }, max_results: { type: 'number', description: '1–10, default 5' } }, ['query']),
    cap: () => null,
    describe: (i) => i.query,
    async run(i, tc) {
      const cfg = loadConfig(tc.os);
      const svc = await serviceFor(tc, cfg);
      const n = Math.max(1, Math.min(10, Math.round(i.max_results ?? 5)));
      let hits: Hit[];
      try {
        hits = await search(svc, i.query, n, tc.signal);
      } catch (err) {
        if (tc.signal.aborted) throw err;
        throw new Error(err instanceof TypeError ? `Could not reach ${svc.name}: ${err.message}` : (err as Error).message);
      }
      const head = `Results from ${svc.name} for “${i.query}”:`;
      const note = svc.id === 'wikipedia' ? '\n\n(Only Wikipedia is searched: no web search service is set up. If the answer needs the wider or more recent web, say so: the user can add a key in Settings → Model → Web search.)' : '';
      if (!hits.length) return `${head} nothing found.${note}`;
      return clip(`${head}\n\n${hits.map((h, k) => `${k + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n\n')}${note}`);
    },
  }),
  tool<{ url: string; max_chars?: number }>({
    name: 'web_fetch',
    description:
      'Read a web page as text (HTML is converted). Pages whose sites do not accept requests from web pages are read through Jina Reader when the user allows it. Long pages are cut at max_chars (default 20000).',
    input_schema: obj({ url: { type: 'string' }, max_chars: { type: 'number' } }, ['url']),
    cap: () => 'net',
    describe: (i) => i.url,
    async run(i, tc) {
      const url = new URL(i.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error('only http and https addresses can be read');
      const max = Math.max(1000, Math.min(100_000, Math.round(i.max_chars ?? 20_000)));
      const cut = (t: string) => (t.length > max ? `${t.slice(0, max)}\n\n[cut at ${max} of ${t.length} characters: ask for more with a larger max_chars]` : t);
      let direct: string | null = null;
      try {
        const res = await fetch(url, { signal: tc.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        const type = res.headers.get('content-type') ?? '';
        if (res.ok) direct = type.includes('html') ? htmlToText(await res.text()) : type.startsWith('text/') || type.includes('json') || type.includes('xml') ? await res.text() : `(${type || 'binary'} content: use http_fetch with save_to to download it)`;
        else direct = `HTTP ${res.status} ${res.statusText}`;
        if (res.ok) return cut(`${url.href}\n\n${direct}`);
      } catch (err) {
        if (tc.signal.aborted) throw err;
      }
      // The site does not let web pages read it (or failed): Jina Reader, when allowed.
      const cfg = loadConfig(tc.os);
      if (!cfg.jinaReader) throw new Error(`${url.host} ${direct ? `answered ${direct}` : 'does not accept requests from web pages'}, and reading through Jina Reader is turned off (Settings → Model → Web search).`);
      const key = await tc.os.secrets.get('search.jina').catch(() => null);
      const res = await fetch(`https://r.jina.ai/${url.href}`, { signal: tc.signal, credentials: 'omit', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-return-format': 'markdown' } }).catch((err: Error) => {
        throw new Error(`Could not reach ${url.host} or Jina Reader: ${err.message}`);
      });
      if (res.status === 429) throw new Error('Jina Reader says too many requests for now (HTTP 429). Wait a little, or add a Jina key in Settings → Model → Web search.');
      if (!res.ok) throw new Error(`Jina Reader could not read ${url.href} (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return cut(`${url.href} (read through Jina Reader)\n\n${await res.text()}`);
    },
  }),
];
