/**
 * The language of ```ui blocks (a subset of OpenUI Lang): statements
 * `name = expression`, one per line (a statement may continue over lines while
 * brackets are open). Parsing never throws: what cannot be read is skipped and
 * reported, so a half-streamed or slightly wrong block still shows what it can.
 */
export type Expr =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'arr'; items: Expr[] }
  | { t: 'obj'; entries: Array<[string, Expr]> }
  | { t: 'ref'; name: string }
  | { t: 'state'; name: string }
  | { t: 'call'; name: string; args: Expr[] }
  | { t: 'action'; name: string; args: Expr[] };

export interface Program {
  /** Statements by name, in the order they came. */
  defs: Map<string, Expr>;
  /** The name to draw: `root`, else the first statement. */
  root: string | null;
  /** Statements that could not be read (shown to nobody but tests and the console). */
  errors: string[];
}

type Tok = { k: 'id' | 'str' | 'num' | 'punct' | 'at' | 'dollar'; v: string };

function tokenize(src: string): { toks: Tok[]; error?: string } {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[++j]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'u' ? String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16) || 0x3f) : e;
          if (e === 'u') j += 4;
        } else out += src[j];
      }
      if (j >= src.length) return { toks, error: 'unterminated string' };
      toks.push({ k: 'str', v: out });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num && (c === '-' || /\d/.test(c))) {
      toks.push({ k: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][\w.-]*/.exec(src.slice(i));
    if (id) {
      toks.push({ k: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    if (c === '@' || c === '$') {
      toks.push({ k: c === '@' ? 'at' : 'dollar', v: c });
      i++;
      continue;
    }
    if ('()[]{},:='.includes(c)) {
      toks.push({ k: 'punct', v: c });
      i++;
      continue;
    }
    return { toks, error: `unexpected “${c}”` };
  }
  return { toks };
}

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  take(v?: string): Tok {
    const t = this.toks[this.i];
    if (!t || (v !== undefined && t.v !== v)) throw new Error(`expected ${v ?? 'more'}${t ? `, found “${t.v}”` : ''}`);
    this.i++;
    return t;
  }
  list(close: string, item: () => void): void {
    while (this.peek()?.v !== close) {
      item();
      if (this.peek()?.v === ',') this.take(',');
      else if (this.peek()?.v !== close) throw new Error(`expected , or ${close}`);
    }
    this.take(close);
  }
  expr(): Expr {
    const t = this.take();
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'num') return { t: 'num', v: Number(t.v) };
    if (t.k === 'dollar') return { t: 'state', name: this.take().v };
    if (t.k === 'at') {
      const name = `@${this.take().v}`;
      const args: Expr[] = [];
      if (this.peek()?.v === '(') {
        this.take('(');
        this.list(')', () => args.push(this.expr()));
      }
      return { t: 'action', name, args };
    }
    if (t.v === '[') {
      const items: Expr[] = [];
      this.list(']', () => items.push(this.expr()));
      return { t: 'arr', items };
    }
    if (t.v === '{') {
      const entries: Array<[string, Expr]> = [];
      this.list('}', () => {
        const key = this.take().v;
        this.take(':');
        entries.push([key, this.expr()]);
      });
      return { t: 'obj', entries };
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') return { t: 'bool', v: t.v === 'true' };
      if (t.v === 'null') return { t: 'null' };
      if (this.peek()?.v === '(') {
        this.take('(');
        const args: Expr[] = [];
        this.list(')', () => args.push(this.expr()));
        return { t: 'call', name: t.v, args };
      }
      return { t: 'ref', name: t.v };
    }
    throw new Error(`unexpected “${t.v}”`);
  }
}

/** Splits the source into statements: a line, joined with the next ones while brackets are open. */
function statements(src: string, complete: boolean): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  // While streaming, the last line may be half written.
  if (!complete) lines.pop();
  for (const line of lines) {
    if (!cur && (/^\s*(#|\/\/)/.test(line) || !line.trim())) continue;
    cur += (cur ? '\n' : '') + line;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
    }
    if (depth <= 0 && !quote) {
      out.push(cur);
      cur = '';
      depth = 0;
    }
  }
  if (cur && complete) out.push(cur);
  return out;
}

/** Reads a block. `complete` is false while it is still streaming (its last line is left out). */
export function parseUi(src: string, complete = true): Program {
  const defs = new Map<string, Expr>();
  const errors: string[] = [];
  for (const stmt of statements(src, complete)) {
    const m = /^\s*(\$?[A-Za-z_][\w-]*)\s*=\s*([\s\S]*)$/.exec(stmt);
    if (!m) {
      errors.push(`not a statement: ${stmt.slice(0, 60)}`);
      continue;
    }
    const { toks, error } = tokenize(m[2]!);
    if (error) {
      errors.push(`${m[1]}: ${error}`);
      continue;
    }
    try {
      const p = new Parser(toks);
      const e = p.expr();
      if (p.peek()) throw new Error(`unexpected “${p.peek()!.v}” after the expression`);
      defs.set(m[1]!, e);
    } catch (err) {
      errors.push(`${m[1]}: ${(err as Error).message}`);
    }
  }
  const root = defs.has('root') ? 'root' : ([...defs.keys()].find((k) => !k.startsWith('$')) ?? null);
  return { defs, root, errors };
}
