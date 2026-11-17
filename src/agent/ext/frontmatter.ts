/** Parses the small YAML subset used in skill, agent and command files: `key: value` lines between `---` fences. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1 || line.trimStart().startsWith('#')) continue;
    meta[line.slice(0, i).trim().toLowerCase()] = line
      .slice(i + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

/** `a, b` or `[a, b]` → ['a', 'b'] */
export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter(Boolean);
}

export function formatFrontmatter(meta: Record<string, string>, body: string): string {
  return `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body.trim()}\n`;
}
