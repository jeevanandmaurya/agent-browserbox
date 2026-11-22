import { fromBase64, gitBlobSha, pool, toBase64 } from './files.js';

export const GITHUB_API = 'https://api.github.com';

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * GitHub through its REST API, which (unlike git's own HTTP protocol)
 * accepts requests from web pages. Pushing writes blobs, a tree and a commit
 * with the Git Data API and moves the branch: one commit with the folder's
 * current files on top of the branch.
 */
export class GitHub {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
    private api = GITHUB_API,
  ) {}

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.api}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError('could not reach api.github.com (offline?)', 0);
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { message?: string; errors?: Array<{ message?: string }> };
    if (!res.ok) {
      const detail = data.errors?.map((e) => e.message).filter(Boolean).join('; ');
      const hint = res.status === 401 ? ' (the token is invalid or expired: gh auth login)' : res.status === 403 || res.status === 404 ? ' (does the token have access to this repository, with Contents read and write?)' : '';
      throw new GitHubError(`GitHub: ${data.message ?? res.statusText}${detail ? `: ${detail}` : ''}${hint}`, res.status);
    }
    return data as T;
  }

  user() {
    return this.req<{ login: string; name: string | null; html_url: string }>('GET', '/user');
  }

  repo(full: string) {
    return this.req<{ full_name: string; default_branch: string; html_url: string; private: boolean }>('GET', `/repos/${full}`);
  }

  createRepo(name: string, opts: { private?: boolean; description?: string; org?: string } = {}) {
    return this.req<{ full_name: string; html_url: string; default_branch: string }>('POST', opts.org ? `/orgs/${opts.org}/repos` : '/user/repos', { name, private: !!opts.private, description: opts.description, auto_init: true });
  }

  async #head(full: string, branch: string): Promise<string | null> {
    try {
      return (await this.req<{ object: { sha: string } }>('GET', `/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) return null;
      throw err;
    }
  }

  /**
   * Makes `branch` hold exactly `files` (relative path → bytes), as one new
   * commit. Only blobs GitHub does not have are uploaded. Returns null when
   * nothing changed.
   */
  async push(full: string, branch: string, files: Map<string, Uint8Array>, message: string, progress?: (msg: string) => void): Promise<{ sha: string; url: string; added: number; changed: number; removed: number } | null> {
    const repo = await this.repo(full);
    let parent = await this.#head(full, branch);
    // A new branch starts from the default branch. An empty repository gets a first commit through the Contents API.
    if (!parent) parent = await this.#head(full, repo.default_branch);
    if (!parent) {
      await this.req('PUT', `/repos/${full}/contents/.gitkeep`, { message: 'Initial commit', content: '', branch });
      parent = await this.#head(full, branch);
      if (!parent) throw new GitHubError('could not start the empty repository', 0);
    }
    const base = await this.req<{ tree: { sha: string } }>('GET', `/repos/${full}/git/commits/${parent}`);
    const remote = await this.req<{ tree: TreeEntry[]; truncated: boolean }>('GET', `/repos/${full}/git/trees/${base.tree.sha}?recursive=1`);
    const remoteBlobs = new Map(remote.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]));
    const local = await Promise.all([...files].map(async ([path, data]) => ({ path, data, sha: await gitBlobSha(data) })));
    const upload = local.filter((f) => remoteBlobs.get(f.path)?.sha !== f.sha);
    let done = 0;
    await pool(upload, 6, async (f) => {
      const r = await this.req<{ sha: string }>('POST', `/repos/${full}/git/blobs`, { content: toBase64(f.data), encoding: 'base64' });
      if (r.sha !== f.sha) throw new GitHubError(`checksum mismatch for ${f.path}`, 0);
      progress?.(`uploaded ${++done}/${upload.length} ${f.path}`);
    });
    const removed = [...remoteBlobs.keys()].filter((p) => !files.has(p) && !remote.truncated);
    if (!upload.length && !removed.length) return null;
    const tree = await this.req<{ sha: string }>('POST', `/repos/${full}/git/trees`, {
      // Without base_tree the new tree is exactly these files: anything else is deleted.
      tree: local.map((f) => ({ path: f.path, mode: remoteBlobs.get(f.path)?.mode === '100755' ? '100755' : '100644', type: 'blob', sha: f.sha })),
    });
    const commit = await this.req<{ sha: string; html_url: string }>('POST', `/repos/${full}/git/commits`, { message, tree: tree.sha, parents: [parent] });
    const exists = await this.#head(full, branch);
    if (exists) await this.req('PATCH', `/repos/${full}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
    else await this.req('POST', `/repos/${full}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    const added = upload.filter((f) => !remoteBlobs.has(f.path)).length;
    return { sha: commit.sha, url: commit.html_url, added, changed: upload.length - added, removed: removed.length };
  }

  /** The files on a branch (or the default branch). */
  async clone(full: string, ref?: string, progress?: (msg: string) => void): Promise<{ files: Map<string, Uint8Array>; branch: string }> {
    const repo = await this.repo(full);
    const branch = ref ?? repo.default_branch;
    const head = await this.#head(full, branch);
    if (!head) return { files: new Map(), branch };
    const commit = await this.req<{ tree: { sha: string } }>('GET', `/repos/${full}/git/commits/${head}`);
    const tree = await this.req<{ tree: TreeEntry[]; truncated: boolean }>('GET', `/repos/${full}/git/trees/${commit.tree.sha}?recursive=1`);
    const blobs = tree.tree.filter((e) => e.type === 'blob');
    if (blobs.length > 3000) throw new GitHubError(`${full} has ${blobs.length} files; that is too many to fetch one by one`, 0);
    const files = new Map<string, Uint8Array>();
    let n = 0;
    await pool(blobs, 8, async (e) => {
      const b = await this.req<{ content: string }>('GET', `/repos/${full}/git/blobs/${e.sha}`);
      files.set(e.path, fromBase64(b.content));
      progress?.(`${++n}/${blobs.length} ${e.path}`);
    });
    return { files, branch };
  }

  createPr(full: string, pr: { head: string; base?: string; title: string; body?: string; draft?: boolean }) {
    return this.repo(full).then((r) => this.req<{ html_url: string; number: number }>('POST', `/repos/${full}/pulls`, { head: pr.head, base: pr.base ?? r.default_branch, title: pr.title, body: pr.body ?? '', draft: !!pr.draft }));
  }

  /** Turns on GitHub Pages for a branch and returns the site's address. */
  async enablePages(full: string, branch: string): Promise<string> {
    try {
      await this.req('POST', `/repos/${full}/pages`, { source: { branch, path: '/' } });
    } catch (err) {
      // Already on: point it at this branch.
      if (!(err instanceof GitHubError && (err.status === 409 || err.status === 422))) throw err;
      await this.req('PUT', `/repos/${full}/pages`, { source: { branch, path: '/' } });
    }
    return (await this.req<{ html_url: string }>('GET', `/repos/${full}/pages`)).html_url;
  }
}
