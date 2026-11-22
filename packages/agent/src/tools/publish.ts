import { obj, tool } from './types.js';

/** Shipping work: GitHub and deploys. Both use the network and the user's accounts. */
export const publishTools = [
  tool<{ action: 'status' | 'push' | 'clone' | 'create_repo' | 'create_pr'; path?: string; repo?: string; branch?: string; message?: string; private?: boolean; title?: string; body?: string; head?: string; base?: string }>({
    name: 'github',
    description:
      "Work with GitHub through its REST API (git's own protocol does not work from a browser). status: who is signed in, and where folders were pushed. push: commit a folder's current files to a repository branch as one commit (creates the repository if needed; private unless private=false; .gitignore respected); repeat pushes of a folder go to the same place. clone: fetch a repository's files into a folder. create_repo: a new repository. create_pr: open a pull request from head into base. Needs the user's GitHub token (Settings → Accounts).",
    input_schema: obj(
      {
        action: { type: 'string', enum: ['status', 'push', 'clone', 'create_repo', 'create_pr'] },
        path: { type: 'string', description: 'folder to push, or to clone into' },
        repo: { type: 'string', description: 'owner/name, or just name for your own account' },
        branch: { type: 'string' },
        message: { type: 'string', description: 'commit message' },
        private: { type: 'boolean' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string', description: 'create_pr: the branch with the changes' },
        base: { type: 'string', description: 'create_pr: the branch to merge into (default branch if omitted)' },
      },
      ['action'],
    ),
    cap: (i) => (i.action === 'status' ? null : 'net'),
    describe: (i) => (i.action === 'push' ? `Push ${i.path ?? '.'} to GitHub${i.repo ? ` (${i.repo})` : ''}` : i.action === 'create_pr' ? `Open a pull request: ${i.title ?? ''}` : `GitHub: ${i.action} ${i.repo ?? ''}`),
    async run(i, tc) {
      const pub = await import('../publish/index.js');
      const say = (m: string) => tc.progress(m + '\n');
      if (i.action === 'status') {
        const who = await pub
          .github(tc.os)
          .then((gh) => gh.user())
          .then((u) => `Signed in to GitHub as ${u.login}.`, (e: Error) => e.message);
        const links = tc.os.settings.get<Record<string, unknown>>('publish.links', {});
        return `${who}\nFolders and where they were published:\n${JSON.stringify(links, null, 2)}`;
      }
      if (i.action === 'push') return pub.pushFolder(tc.os, tc.path(i.path ?? '.'), { repo: i.repo, branch: i.branch, message: i.message, private: i.private }, say);
      if (i.action === 'clone') {
        if (!i.repo) throw new Error('clone needs repo');
        return pub.cloneRepo(tc.os, i.repo, i.path ? tc.path(i.path) : null, tc.shell.cwd, { branch: i.branch }, say);
      }
      const gh = await pub.github(tc.os);
      if (i.action === 'create_repo') {
        if (!i.repo) throw new Error('create_repo needs repo');
        const r = await gh.createRepo(i.repo.split('/').pop()!, { private: i.private ?? true, org: i.repo.includes('/') ? i.repo.split('/')[0] : undefined });
        return `Created ${r.full_name}: ${r.html_url}`;
      }
      const repo = await pub.repoName(gh, i.repo ?? pub.linksFor(tc.os, tc.shell.cwd).github?.repo ?? '');
      if (!i.head || !i.title) throw new Error('create_pr needs head and title');
      const pr = await gh.createPr(repo, { head: i.head, base: i.base, title: i.title, body: i.body });
      return `Opened pull request #${pr.number}: ${pr.html_url}`;
    },
  }),
  tool<{ path?: string; target?: 'netlify' | 'vercel' | 'github-pages'; name?: string; repo?: string }>({
    name: 'deploy',
    description:
      "Build a web project for production (pages bundled and minified, npm packages included) and publish it as a static site: netlify, vercel or github-pages. Returns the live URL. The first deploy of a folder needs a target; later ones reuse it and update the same site. A server.ts backend is not deployed (static hosting). Needs the user's token for that host (Settings → Accounts).",
    input_schema: obj({
      path: { type: 'string', description: 'project folder (default: working directory)' },
      target: { type: 'string', enum: ['netlify', 'vercel', 'github-pages'] },
      name: { type: 'string', description: 'site or project name (first deploy)' },
      repo: { type: 'string', description: 'github-pages: owner/name' },
    }),
    cap: () => 'net',
    describe: (i) => `Deploy ${i.path ?? '.'}${i.target ? ` to ${i.target}` : ''}`,
    async run(i, tc) {
      const pub = await import('../publish/index.js');
      const r = await pub.deployFolder(tc.os, tc.path(i.path ?? '.'), { target: i.target, name: i.name, repo: i.repo }, (m) => tc.progress(m + '\n'));
      return `Deployed ${r.files} files to ${r.target}: ${r.url}${r.note}`;
    },
  }),
];
