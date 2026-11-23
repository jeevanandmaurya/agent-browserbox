/** POSIX-style path helpers. All VFS paths are absolute and normalized. */

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

export function resolve(cwd: string, path: string): string {
  if (!path) return normalize(cwd);
  return normalize(path.startsWith('/') ? path : `${cwd}/${path}`);
}

export function dirname(path: string): string {
  const p = normalize(path);
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalize(path);
  return p.slice(p.lastIndexOf('/') + 1);
}

export function extname(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

export function join(...parts: string[]): string {
  return normalize(parts.join('/'));
}

/** True when `path` is `root` or lives underneath it. */
export function isInside(root: string, path: string): boolean {
  const r = normalize(root);
  const p = normalize(path);
  return r === '/' || p === r || p.startsWith(r + '/');
}

/** Converts a glob (`*`, `**`, `?`, `{a,b}`) to a RegExp over normalized paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',' ) re += '|';
    else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}
