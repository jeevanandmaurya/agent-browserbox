import { pool, sha1 } from './files.js';

/** A static site: path (/index.html) → bytes. */
export type Site = Map<string, Uint8Array>;

async function call<T>(fetcher: typeof fetch, url: string, init: RequestInit, host: string): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, init);
  } catch {
    throw new Error(`could not reach ${host} (offline?)`);
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: { message?: string } | string };
  if (!res.ok) {
    const msg = typeof data.error === 'string' ? data.error : (data.error?.message ?? data.message ?? res.statusText);
    throw new Error(`${host}: ${msg}${res.status === 401 || res.status === 403 ? ' (check the token in Settings → Accounts)' : ''}`);
  }
  return data as T;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Netlify's file-digest deploy: send the list of files with their SHA-1,
 * upload only those Netlify does not have, then wait until it is live.
 */
export async function deployNetlify(token: string, site: Site, opts: { siteId?: string; name?: string; fetcher?: typeof fetch; progress?: (m: string) => void }): Promise<{ url: string; siteId: string; adminUrl?: string }> {
  const f = opts.fetcher ?? fetch;
  const api = 'https://api.netlify.com/api/v1';
  const auth = { authorization: `Bearer ${token}` };
  let siteId = opts.siteId;
  if (!siteId) {
    const created = await call<{ id: string; ssl_url?: string; url: string }>(f, `${api}/sites`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(opts.name ? { name: opts.name } : {}) }, 'Netlify');
    siteId = created.id;
  }
  const digests = new Map<string, string>();
  for (const [path, data] of site) digests.set(path, await sha1(data));
  const deploy = await call<{ id: string; required: string[] }>(f, `${api}/sites/${siteId}/deploys`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ files: Object.fromEntries(digests) }) }, 'Netlify');
  const required = new Set(deploy.required ?? []);
  const uploads = [...site].filter(([path]) => required.has(digests.get(path)!));
  let n = 0;
  await pool(uploads, 4, async ([path, data]) => {
    await call(f, `${api}/deploys/${deploy.id}/files${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: data as Uint8Array<ArrayBuffer> }, 'Netlify');
    opts.progress?.(`uploaded ${++n}/${uploads.length} ${path}`);
  });
  for (let i = 0; i < 60; i++) {
    const d = await call<{ state: string; ssl_url?: string; url: string; error_message?: string; admin_url?: string }>(f, `${api}/deploys/${deploy.id}`, { headers: auth }, 'Netlify');
    if (d.state === 'ready') return { url: d.ssl_url ?? d.url, siteId, adminUrl: d.admin_url };
    if (d.state === 'error') throw new Error(`Netlify: ${d.error_message ?? 'the deploy failed'}`);
    opts.progress?.(`Netlify: ${d.state}…`);
    await wait(2000);
  }
  throw new Error('Netlify: the deploy did not finish within two minutes; check the Netlify dashboard');
}

/** Vercel: upload each file by SHA-1, then create a production deployment and wait for it. */
export async function deployVercel(token: string, site: Site, opts: { name: string; team?: string; fetcher?: typeof fetch; progress?: (m: string) => void }): Promise<{ url: string }> {
  const f = opts.fetcher ?? fetch;
  const q = opts.team ? `?teamId=${encodeURIComponent(opts.team)}` : '';
  const auth = { authorization: `Bearer ${token}` };
  const files = await Promise.all([...site].map(async ([path, data]) => ({ file: path.replace(/^\//, ''), data, sha: await sha1(data) })));
  let n = 0;
  await pool(files, 4, async (x) => {
    await call(f, `https://api.vercel.com/v2/files${q}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-vercel-digest': x.sha }, body: x.data as Uint8Array<ArrayBuffer> }, 'Vercel');
    opts.progress?.(`uploaded ${++n}/${files.length} ${x.file}`);
  });
  const dep = await call<{ id: string; url: string; readyState: string }>(f, `https://api.vercel.com/v13/deployments${q}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: opts.name, target: 'production', files: files.map((x) => ({ file: x.file, sha: x.sha, size: x.data.length })), projectSettings: { framework: null, buildCommand: null, outputDirectory: null } }),
  }, 'Vercel');
  for (let i = 0; i < 60; i++) {
    const d = await call<{ readyState: string; url: string; alias?: string[]; errorMessage?: string }>(f, `https://api.vercel.com/v13/deployments/${dep.id}${q}`, { headers: auth }, 'Vercel');
    if (d.readyState === 'READY') return { url: `https://${d.alias?.[0] ?? d.url}` };
    if (d.readyState === 'ERROR' || d.readyState === 'CANCELED') throw new Error(`Vercel: ${d.errorMessage ?? d.readyState.toLowerCase()}`);
    opts.progress?.(`Vercel: ${d.readyState.toLowerCase()}…`);
    await wait(2000);
  }
  throw new Error('Vercel: the deployment did not finish within two minutes; check the Vercel dashboard');
}
