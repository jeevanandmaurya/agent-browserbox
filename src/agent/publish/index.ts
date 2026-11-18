import type { KernelCore } from '@/kernel/kernel';
import { basename, join, normalize } from '@/kernel/vfs/path';
import { buildSite } from '@/kernel/dev/build';
import { collectFiles } from './files';
import { GitHub } from './github';
import { deployNetlify, deployVercel, type Site } from './hosts';

/** Secret names for the accounts in Settings → Accounts. Only the kernel reads them. */
export const TOKENS = { github: 'github.token', netlify: 'netlify.token', vercel: 'vercel.token' } as const;
export type Account = keyof typeof TOKENS;
export type DeployTarget = 'netlify' | 'vercel' | 'github-pages';
export const DEPLOY_TARGETS: DeployTarget[] = ['netlify', 'vercel', 'github-pages'];

/** Where a folder was last pushed and deployed, so the next time needs no options. */
export interface FolderLinks {
  github?: { repo: string; branch: string };
  netlify?: { siteId: string; url: string };
  vercel?: { name: string; url: string };
  pages?: { repo: string; url: string };
  last?: DeployTarget;
}
const LINKS = 'publish.links';
export const linksFor = (os: KernelCore, dir: string): FolderLinks => os.settings.get<Record<string, FolderLinks>>(LINKS, {})[normalize(dir)] ?? {};
function link(os: KernelCore, dir: string, patch: FolderLinks): void {
  const all = os.settings.get<Record<string, FolderLinks>>(LINKS, {});
  all[normalize(dir)] = { ...all[normalize(dir)], ...patch };
  os.settings.set(LINKS, all);
}

const HOW: Record<Account, string> = {
  github: 'Create a fine-grained token at github.com/settings/personal-access-tokens (Contents, Pull requests, Pages and Administration: read and write, for the repositories you want) and add it in Settings → Accounts, or run gh auth login.',
  netlify: 'Create a personal access token at app.netlify.com/user/applications and add it in Settings → Accounts.',
  vercel: 'Create a token at vercel.com/account/tokens and add it in Settings → Accounts.',
};

export async function token(os: KernelCore, account: Account): Promise<string> {
  const t = await os.secrets.get(TOKENS[account]);
  if (!t) throw new Error(`No ${account === 'github' ? 'GitHub' : account === 'netlify' ? 'Netlify' : 'Vercel'} token yet. ${HOW[account]}`);
  return t;
}

export const github = async (os: KernelCore, fetcher?: typeof fetch) => new GitHub(await token(os, 'github'), fetcher);

/** "owner/name" from "owner/name", "name" (the signed-in user's) or a github.com URL. */
export async function repoName(gh: GitHub, spec: string): Promise<string> {
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(spec);
  if (m) return m[1]!;
  return spec.includes('/') ? spec : `${(await gh.user()).login}/${spec}`;
}

/**
 * Pushes a folder to GitHub as one commit: the repository is the one given,
 * the one this folder was pushed to before, or a new one named after it.
 */
export async function pushFolder(
  os: KernelCore,
  dir: string,
  opts: { repo?: string; branch?: string; message?: string; private?: boolean; fetcher?: typeof fetch },
  progress: (m: string) => void = () => undefined,
): Promise<string> {
  const gh = await github(os, opts.fetcher);
  const known = linksFor(os, dir).github;
  const full = await repoName(gh, opts.repo ?? known?.repo ?? basename(dir));
  try {
    await gh.repo(full);
  } catch {
    const [owner, name] = full.split('/') as [string, string];
    const me = (await gh.user()).login;
    progress(`creating ${full} on GitHub…`);
    await gh.createRepo(name, { private: opts.private ?? true, org: owner === me ? undefined : owner });
  }
  const branch = opts.branch ?? known?.branch ?? (await gh.repo(full)).default_branch;
  const files = await collectFiles(os.fs, dir);
  progress(`${files.size} files in ${dir}`);
  const r = await gh.push(full, branch, files, opts.message ?? `Update from BrowserBox`, progress);
  link(os, dir, { github: { repo: full, branch } });
  if (!r) return `Nothing to push: ${full} (${branch}) already has these files. https://github.com/${full}/tree/${branch}`;
  return `Pushed to ${full} (${branch}): ${r.added} added, ${r.changed} changed, ${r.removed} removed. ${r.url}`;
}

export async function cloneRepo(os: KernelCore, spec: string, dir: string | null, cwd: string, opts: { branch?: string; fetcher?: typeof fetch } = {}, progress: (m: string) => void = () => undefined): Promise<string> {
  const gh = await github(os, opts.fetcher);
  const full = await repoName(gh, spec);
  const target = dir ?? join(cwd, full.split('/')[1]!);
  if ((await os.fs.readdir(target).catch(() => [])).length) throw new Error(`${target} is not empty`);
  const { files, branch } = await gh.clone(full, opts.branch, progress);
  for (const [path, data] of files) await os.fs.writeFile(join(target, path), data);
  link(os, target, { github: { repo: full, branch } });
  return `Cloned ${full} (${branch}, ${files.size} files) into ${target}. gh push sends changes back as a commit.`;
}

/**
 * Builds a project for production and publishes it: Netlify, Vercel or
 * GitHub Pages. Static hosting: a server.ts backend is not deployed.
 */
export async function deployFolder(
  os: KernelCore,
  dir: string,
  opts: { target?: DeployTarget; name?: string; repo?: string; fetcher?: typeof fetch },
  progress: (m: string) => void = () => undefined,
): Promise<{ url: string; target: DeployTarget; files: number; note: string }> {
  const links = linksFor(os, dir);
  const target = opts.target ?? links.last;
  if (!target) throw new Error(`Where to? Pass a target: ${DEPLOY_TARGETS.join(', ')}.`);
  progress('building for production…');
  const built = await buildSite(os.fs, dir);
  if (built.errors.length) throw new Error(`The build failed:\n${built.errors.join('\n')}`);
  const site: Site = built.files;
  progress(`built ${site.size} files`);
  const name = (opts.name ?? basename(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  let url: string;
  if (target === 'netlify') {
    const r = await deployNetlify(await token(os, 'netlify'), site, { siteId: links.netlify?.siteId, name: links.netlify ? undefined : name, fetcher: opts.fetcher, progress });
    url = r.url;
    link(os, dir, { netlify: { siteId: r.siteId, url }, last: target });
  } else if (target === 'vercel') {
    const r = await deployVercel(await token(os, 'vercel'), site, { name: links.vercel?.name ?? name, fetcher: opts.fetcher, progress });
    url = r.url;
    link(os, dir, { vercel: { name: links.vercel?.name ?? name, url }, last: target });
  } else {
    const gh = await github(os, opts.fetcher);
    const full = await repoName(gh, opts.repo ?? links.pages?.repo ?? links.github?.repo ?? name);
    try {
      await gh.repo(full);
    } catch {
      progress(`creating ${full} on GitHub…`);
      await gh.createRepo(full.split('/')[1]!, { private: false });
    }
    const files = new Map([...site].map(([p, d]) => [p.replace(/^\//, ''), d] as const));
    files.set('.nojekyll', new Uint8Array());
    await gh.push(full, 'gh-pages', files, 'Deploy from BrowserBox', progress);
    url = await gh.enablePages(full, 'gh-pages');
    link(os, dir, { pages: { repo: full, url }, last: target });
  }
  const note = built.backend ? ` Note: ${built.backend} (the backend) is not deployed: these hosts serve the static site only.` : '';
  return { url, target, files: site.size, note };
}
