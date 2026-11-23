import * as esbuildWasm from 'esbuild-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { setEsbuildLoader } from '../src/kernel/dev/bundle';
import { AgentOs } from '../packages/agent/src/index';
import { kernelBox } from './helpers/kernel-box';
import { deployFolder, pushFolder, cloneRepo, linksFor } from '../packages/agent/src/publish';
import { gitBlobSha, sha1, fromBase64 } from '../packages/agent/src/publish/files';

beforeAll(async () => {
  await esbuildWasm.initialize({});
});

/** The agent's view of a real (in-memory) kernel, with the publishing tokens. */
let lastKernel: Awaited<ReturnType<typeof kernelBox>>['kernel'];
async function kernel() {
  const { box, kernel: k } = await kernelBox();
  lastKernel = k;
  setEsbuildLoader(async () => esbuildWasm); // the kernel installs its own loader; tests use the npm build
  return AgentOs.create(box, { secrets: { 'github.token': 'gh-token', 'netlify.token': 'nf-token', 'vercel.token': 'vc-token' }, seed: false });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An in-memory GitHub: repositories with real blob ids, trees, commits and branches. */
function fakeGitHub() {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Array<{ path: string; mode: string; type: 'blob'; sha: string }>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const repos = new Map<string, { default_branch: string; refs: Map<string, string>; pages?: string; private: boolean }>();
  const pulls: unknown[] = [];
  let n = 0;
  const id = () => (++n).toString(16).padStart(40, '0');
  const calls: string[] = [];
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    if (new Headers(init.headers).get('authorization') !== 'Bearer gh-token') return json({ message: 'Bad credentials' }, 401);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const p = url.pathname;
    calls.push(`${method} ${p}`);
    if (p === '/user') return json({ login: 'ada', name: 'Ada' });
    if (p === '/user/repos' && method === 'POST') {
      const full = `ada/${body.name}`;
      const tree = id();
      trees.set(tree, []);
      const c = id();
      commits.set(c, { tree, parents: [], message: 'Initial commit' });
      repos.set(full, { default_branch: 'main', refs: new Map([['main', c]]), private: body.private });
      return json({ full_name: full, html_url: `https://github.com/${full}`, default_branch: 'main' }, 201);
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
    if (!m) return json({ message: 'Not Found' }, 404);
    const [, full, rest = ''] = m as unknown as [string, string, string];
    const repo = repos.get(full);
    if (!repo) return json({ message: 'Not Found' }, 404);
    if (!rest) return json({ full_name: full, default_branch: repo.default_branch, html_url: `https://github.com/${full}`, private: repo.private });
    let r: RegExpExecArray | null;
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = repo.refs.get(decodeURIComponent(r[1]!));
      return sha ? json({ object: { sha } }) : json({ message: 'Not Found' }, 404);
    }
    if ((r = /^\/git\/commits\/(\w+)$/.exec(rest))) return json({ tree: { sha: commits.get(r[1]!)!.tree } });
    if ((r = /^\/git\/trees\/(\w+)$/.exec(rest)) && method === 'GET') return json({ tree: trees.get(r[1]!), truncated: false });
    if (rest === '/git/blobs' && method === 'POST') {
      const data = fromBase64(body.content);
      const sha = await gitBlobSha(data);
      blobs.set(sha, data);
      return json({ sha }, 201);
    }
    if ((r = /^\/git\/blobs\/(\w+)$/.exec(rest))) return json({ content: Buffer.from(blobs.get(r[1]!)!).toString('base64') });
    if (rest === '/git/trees' && method === 'POST') {
      const t = id();
      trees.set(t, body.tree);
      return json({ sha: t }, 201);
    }
    if (rest === '/git/commits' && method === 'POST') {
      const c = id();
      commits.set(c, body);
      return json({ sha: c, html_url: `https://github.com/${full}/commit/${c}` }, 201);
    }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      repo.refs.set(decodeURIComponent(r[1]!), body.sha);
      return json({});
    }
    if (rest === '/git/refs' && method === 'POST') {
      repo.refs.set(body.ref.replace('refs/heads/', ''), body.sha);
      return json({}, 201);
    }
    if (rest === '/pulls' && method === 'POST') {
      pulls.push(body);
      return json({ number: pulls.length, html_url: `https://github.com/${full}/pull/${pulls.length}` }, 201);
    }
    if (rest === '/pages') {
      if (method === 'POST') {
        if (repo.pages) return json({ message: 'exists' }, 409);
        repo.pages = body.source.branch;
        return json({}, 201);
      }
      if (method === 'PUT') return (repo.pages = body.source.branch), new Response(null, { status: 204 });
      return json({ html_url: `https://${full.split('/')[0]}.github.io/${full.split('/')[1]}/` });
    }
    return json({ message: `unhandled ${method} ${rest}` }, 500);
  }) as typeof fetch;
  /** The files on a branch, as text. */
  const branch = (full: string, b: string) => Object.fromEntries((trees.get(commits.get(repos.get(full)!.refs.get(b)!)!.tree) ?? []).map((e) => [e.path, new TextDecoder().decode(blobs.get(e.sha))]));
  return { fetcher, repos, branch, calls, pulls };
}

describe('GitHub', () => {
  it('pushes a folder as one commit, respecting .gitignore; a second push sends only what changed', async () => {
    const os = await kernel();
    const gh = fakeGitHub();
    await os.fs.writeFile('/w/app/index.html', '<h1>Hi</h1>');
    await os.fs.writeFile('/w/app/src/main.js', 'console.log(1)');
    await os.fs.writeFile('/w/app/.gitignore', 'dist/\n*.log\n');
    await os.fs.writeFile('/w/app/dist/out.js', 'built');
    await os.fs.writeFile('/w/app/debug.log', 'noise');
    await os.fs.writeFile('/w/app/node_modules/x/index.js', 'dep');
    const first = await pushFolder(os, '/w/app', { fetcher: gh.fetcher });
    expect(first).toMatch(/Pushed to ada\/app \(main\): 3 added, 0 changed, 0 removed/);
    expect(gh.repos.get('ada/app')!.private).toBe(true);
    expect(gh.branch('ada/app', 'main')).toEqual({ '.gitignore': 'dist/\n*.log\n', 'index.html': '<h1>Hi</h1>', 'src/main.js': 'console.log(1)' });
    expect(linksFor(os, '/w/app').github).toEqual({ repo: 'ada/app', branch: 'main' });

    await os.fs.writeFile('/w/app/index.html', '<h1>Hello</h1>');
    await os.fs.rm('/w/app/src/main.js');
    gh.calls.length = 0;
    const second = await pushFolder(os, '/w/app', { fetcher: gh.fetcher, message: 'Say hello' });
    expect(second).toMatch(/0 added, 1 changed, 1 removed/);
    expect(gh.calls.filter((c) => c.endsWith('/git/blobs'))).toHaveLength(1); // only the changed file was uploaded
    expect(gh.branch('ada/app', 'main')['index.html']).toBe('<h1>Hello</h1>');
    expect(await pushFolder(os, '/w/app', { fetcher: gh.fetcher })).toMatch(/Nothing to push/);
  });

  it('clones a repository into a folder', async () => {
    const os = await kernel();
    const gh = fakeGitHub();
    await os.fs.writeFile('/w/src/a.txt', 'A');
    await os.fs.writeFile('/w/src/b/c.bin', new Uint8Array([0, 255, 1]));
    await pushFolder(os, '/w/src', { repo: 'ada/thing', fetcher: gh.fetcher });
    const out = await cloneRepo(os, 'ada/thing', null, '/w', { fetcher: gh.fetcher });
    expect(out).toMatch(/Cloned ada\/thing \(main, 2 files\) into \/w\/thing/);
    expect(await os.fs.readText('/w/thing/a.txt')).toBe('A');
    expect([...(await os.fs.readFile('/w/thing/b/c.bin'))]).toEqual([0, 255, 1]);
  });

  it('says how to get a token when there is none', async () => {
    const os = await kernel();
    await os.secrets.delete('github.token');
    await expect(pushFolder(os, '/w', {})).rejects.toThrow(/No GitHub token yet.*Settings → Accounts/);
  });
});

describe('deploy', () => {
  const project = async (os: AgentOs) => {
    await os.fs.writeFile('/w/site/index.html', '<!doctype html><html><head><title>S</title></head><body><div id="root"></div><script type="module" src="/src/main.ts"></script></body></html>');
    await os.fs.writeFile('/w/site/src/main.ts', 'const n: number = 40 + 2;\ndocument.getElementById("root")!.textContent = `answer ${n}`;\nif (import.meta.env.DEV) console.log("dev only");');
    await os.fs.writeFile('/w/site/logo.svg', '<svg/>');
    await os.fs.writeFile('/w/site/server.ts', 'export default { fetch: () => new Response("api") }');
  };

  it('builds for production and deploys to Netlify, uploading only what Netlify lacks', async () => {
    const os = await kernel();
    await project(os);
    const uploaded: string[] = [];
    let digests: Record<string, string> = {};
    const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer nf-token');
      if (url.endsWith('/sites') && init.method === 'POST') return json({ id: 'site1', url: 'http://site.netlify.app' }, 201);
      if (url.endsWith('/sites/site1/deploys')) {
        digests = JSON.parse(String(init.body)).files;
        return json({ id: 'dep1', required: [digests['/index.html']] });
      }
      if (url.includes('/deploys/dep1/files/')) return uploaded.push(url.split('/files')[1]!), json({});
      if (url.endsWith('/deploys/dep1')) return json({ state: 'ready', ssl_url: 'https://site.netlify.app' });
      return json({ message: 'unhandled ' + url }, 500);
    }) as typeof fetch;
    const r = await deployFolder(os, '/w/site', { target: 'netlify', fetcher });
    expect(r.url).toBe('https://site.netlify.app');
    expect(Object.keys(digests).sort()).toEqual(['/index.html', '/logo.svg']);
    expect(uploaded).toEqual(['/index.html']);
    expect(r.note).toMatch(/server\.ts .* not deployed/);
    // The page is a production build: TypeScript compiled, dev-only code dropped, no dev runtime.
    const { buildSite } = await import('../src/kernel/dev/build');
    const html = new TextDecoder().decode((await buildSite(lastKernel.fs, '/w/site')).files.get('/index.html'));
    expect(html).toContain('answer');
    expect(html).not.toContain('dev only');
    expect(html).not.toContain('__bbxDev');
    // Next time, the same site without asking.
    expect(linksFor(os, '/w/site')).toMatchObject({ netlify: { siteId: 'site1' }, last: 'netlify' });
  });

  it('deploys to Vercel', async () => {
    const os = await kernel();
    await project(os);
    const files: string[] = [];
    let body: { name: string; files: Array<{ file: string; sha: string }> } | null = null;
    const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('/v2/files')) {
        const data = new Uint8Array(init.body as ArrayBuffer);
        expect(new Headers(init.headers).get('x-vercel-digest')).toBe(await sha1(data));
        files.push(new Headers(init.headers).get('x-vercel-digest')!);
        return json({});
      }
      if (url.endsWith('/v13/deployments') && init.method === 'POST') return (body = JSON.parse(String(init.body))), json({ id: 'd1', url: 'site-abc.vercel.app', readyState: 'QUEUED' });
      if (url.endsWith('/v13/deployments/d1')) return json({ readyState: 'READY', url: 'site-abc.vercel.app', alias: ['site.vercel.app'] });
      return json({ error: { message: 'unhandled ' + url } }, 500);
    }) as typeof fetch;
    const r = await deployFolder(os, '/w/site', { target: 'vercel', fetcher });
    expect(r.url).toBe('https://site.vercel.app');
    expect(body!.name).toBe('site');
    expect(body!.files.map((f) => f.file).sort()).toEqual(['index.html', 'logo.svg']);
    expect(files).toHaveLength(2);
  });

  it('deploys to GitHub Pages: a gh-pages branch, Pages turned on', async () => {
    const os = await kernel();
    await project(os);
    const gh = fakeGitHub();
    const r = await deployFolder(os, '/w/site', { target: 'github-pages', fetcher: gh.fetcher });
    expect(r.url).toBe('https://ada.github.io/site/');
    expect(gh.repos.get('ada/site')!.pages).toBe('gh-pages');
    expect(Object.keys(gh.branch('ada/site', 'gh-pages')).sort()).toEqual(['.nojekyll', 'index.html', 'logo.svg']);
  });

  it('a failing build is reported, not deployed', async () => {
    const os = await kernel();
    await os.fs.writeFile('/w/bad/index.html', '<script type="module" src="/main.ts"></script>');
    await os.fs.writeFile('/w/bad/main.ts', 'import "./missing";');
    await expect(deployFolder(os, '/w/bad', { target: 'netlify', fetcher: (() => Promise.reject(new Error('must not call'))) as never })).rejects.toThrow(/build failed[\s\S]*missing/);
  });
});
