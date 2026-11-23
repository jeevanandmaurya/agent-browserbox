import type { WithSettings } from './host/os.js';

/**
 * Permission rules: what the agent may do without asking, must always ask
 * about, or may never do, by shell command, file path, URL or tool name.
 * They come before the permission mode: a deny rule blocks even in auto mode,
 * an ask rule prompts even there, and an allow rule skips the prompt in ask mode.
 */
export type RuleAction = 'allow' | 'ask' | 'deny';
export type RuleScope = 'shell' | 'path' | 'url' | 'tool';

export interface PermRule {
  scope: RuleScope;
  /** A glob: `*` is any text, `?` one character. For commands, `git *` also matches plain `git`. */
  pattern: string;
  action: RuleAction;
}

export const RULES_KEY = 'perms.rules';

export function loadRules(os: WithSettings): PermRule[] {
  const list = os.settings.get<unknown>(RULES_KEY, []);
  return Array.isArray(list) ? list.filter((r): r is PermRule => !!r && typeof r.pattern === 'string' && ['shell', 'path', 'url', 'tool'].includes(r.scope) && ['allow', 'ask', 'deny'].includes(r.action)) : [];
}

export function saveRules(os: WithSettings, rules: PermRule[]): void {
  os.settings.set(RULES_KEY, rules);
}

const SCOPE_LABEL: Record<RuleScope, string> = { shell: 'command', path: 'path', url: 'URL', tool: 'tool' };
export const describeRule = (r: PermRule): string => `${r.action} ${SCOPE_LABEL[r.scope]} ${r.pattern}`;

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');

function globRe(pattern: string): RegExp {
  const body = squash(pattern)
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 's');
}

/** Whether `subject` matches `pattern`; a command pattern ending in ` *` also matches the bare command. */
export function matches(pattern: string, subject: string, scope: RuleScope): boolean {
  const s = squash(subject);
  if (globRe(pattern).test(s)) return true;
  const p = squash(pattern);
  return scope === 'shell' && p.endsWith(' *') && s === p.slice(0, -2);
}

/**
 * The simple commands in a command line: split at `&&`, `||`, `;`, `|`, `&`
 * and new lines outside quotes. `unsafe` when it substitutes commands
 * (`$(…)` or backticks), which no allow rule can vouch for.
 */
export function splitCommand(line: string): { parts: string[]; unsafe: boolean } {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let unsafe = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\') {
        cur += c + (line[++i] ?? '');
        continue;
      } else if (quote === '"' && (c === '`' || (c === '$' && line[i + 1] === '('))) unsafe = true;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\') {
      cur += c + (line[++i] ?? '');
      continue;
    } else if (c === '`' || (c === '$' && line[i + 1] === '(')) unsafe = true;
    else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      if ((c === '|' || c === '&') && line[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return { parts, unsafe };
}

/** What a call touches, by scope. */
function subjects(tool: string, input: Record<string, unknown>, resolve: (p: string) => string): Array<{ scope: RuleScope; value: string; whole?: boolean }> {
  const out: Array<{ scope: RuleScope; value: string; whole?: boolean }> = [];
  if (tool === 'shell' && typeof input.command === 'string') {
    for (const part of splitCommand(input.command).parts) out.push({ scope: 'shell', value: part });
  }
  for (const k of ['path', 'from', 'to'] as const) if (typeof input[k] === 'string' && input[k]) out.push({ scope: 'path', value: resolve(input[k] as string) });
  if (typeof input.url === 'string') out.push({ scope: 'url', value: input.url });
  return out;
}

/**
 * The rule that decides this call, or null when none applies and the
 * permission mode decides. Deny wins over ask, ask over allow; a call is
 * allowed only when every command, path and URL it touches is allowed (or an
 * allow rule names the tool).
 */
export function decide(rules: PermRule[], tool: string, input: Record<string, unknown>, resolve: (p: string) => string = (p) => p): { action: RuleAction; rule: PermRule } | null {
  if (!rules.length) return null;
  const subs = subjects(tool, input, resolve);
  const whole = tool === 'shell' && typeof input.command === 'string' ? input.command : null;
  const hit = (r: PermRule) =>
    (r.scope === 'tool' && matches(r.pattern, tool, 'tool')) || subs.some((s) => s.scope === r.scope && matches(r.pattern, s.value, s.scope)) || (r.scope === 'shell' && whole !== null && matches(r.pattern, whole, 'shell'));
  for (const action of ['deny', 'ask'] as const) {
    const rule = rules.find((r) => r.action === action && hit(r));
    if (rule) return { action, rule };
  }
  const allows = rules.filter((r) => r.action === 'allow');
  const byTool = allows.find((r) => r.scope === 'tool' && matches(r.pattern, tool, 'tool'));
  if (byTool) return { action: 'allow', rule: byTool };
  if (!subs.length || (whole !== null && splitCommand(whole).unsafe)) return null;
  let first: PermRule | undefined;
  for (const s of subs) {
    const r = allows.find((a) => a.scope === s.scope && matches(a.pattern, s.value, s.scope));
    if (!r) return null;
    first ??= r;
  }
  return first ? { action: 'allow', rule: first } : null;
}
