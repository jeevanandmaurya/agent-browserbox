/** Shell grammar: `a | b > f && c ; d` with quotes, escapes and $VAR expansion. */

export interface Word {
  text: string;
  /** False when any part was quoted — quoted words are not glob-expanded. */
  bare: boolean;
}

export interface Stage {
  argv: Word[];
  stdin?: Word;
  stdout?: { target: Word; append: boolean };
}

export interface Job {
  stages: Stage[];
  /** Operator that follows this job. */
  next: ';' | '&&' | '||';
}

type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: string };

export class ShellSyntaxError extends Error {}

export function tokenize(line: string, env: Record<string, string>): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let cur = '';
  let has = false;
  let bare = true;
  const flush = () => {
    if (has) tokens.push({ kind: 'word', word: { text: cur, bare } });
    cur = '';
    has = false;
    bare = true;
  };
  const variable = (): string => {
    // at '$'
    if (line[i + 1] === '{') {
      const end = line.indexOf('}', i);
      if (end < 0) throw new ShellSyntaxError('unterminated ${');
      const name = line.slice(i + 2, end);
      i = end;
      return env[name] ?? '';
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^\?/.exec(line.slice(i + 1));
    if (!m) return '$';
    i += m[0].length;
    return env[m[0]] ?? '';
  };
  for (; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new ShellSyntaxError("unterminated '");
      cur += line.slice(i + 1, end);
      i = end;
      has = true;
      bare = false;
    } else if (c === '"') {
      has = true;
      bare = false;
      for (i++; ; i++) {
        const d = line[i];
        if (d === undefined) throw new ShellSyntaxError('unterminated "');
        if (d === '"') break;
        if (d === '\\' && '"\\$`'.includes(line[i + 1] ?? '')) cur += line[++i];
        else if (d === '$') cur += variable();
        else cur += d;
      }
    } else if (c === '\\') {
      if (i + 1 < line.length) cur += line[++i];
      has = true;
      bare = false;
    } else if (c === '$') {
      cur += variable();
      has = true;
    } else if (c === ' ' || c === '\t' || c === '\n') {
      flush();
    } else if (c === '#' && !has) {
      break;
    } else if ('|&;<>'.includes(c)) {
      flush();
      const two = line.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '>>') {
        tokens.push({ kind: 'op', op: two });
        i++;
      } else if (c === '&') throw new ShellSyntaxError('background jobs (&) are not supported');
      else tokens.push({ kind: 'op', op: c });
    } else {
      if (c === '~' && !has && /^(\/|\s|$)/.test(line.slice(i + 1))) cur += env.HOME ?? '~';
      else cur += c;
      has = true;
    }
  }
  flush();
  return tokens;
}

/**
 * Splits a line into jobs at top-level `;`, `&&` and `||` without expanding
 * anything, so each job is parsed (and its $VARS read) only when it runs —
 * that is what makes `false; echo $?` print 1.
 */
export function splitJobs(line: string): Array<{ src: string; next: Job['next'] }> {
  const out: Array<{ src: string; next: Job['next'] }> = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '\\') i++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      line = line.slice(0, i);
      break;
    } else if (c === ';' || line.startsWith('&&', i) || line.startsWith('||', i)) {
      const op = c === ';' ? ';' : (line.slice(i, i + 2) as Job['next']);
      out.push({ src: line.slice(start, i), next: op });
      i += op.length - 1;
      start = i + 1;
    }
  }
  out.push({ src: line.slice(start), next: ';' });
  return out.filter((j, i, all) => j.src.trim() || (j.next !== ';' && i < all.length - 1));
}

export function parse(line: string, env: Record<string, string>): Job[] {
  const tokens = tokenize(line, env);
  const jobs: Job[] = [];
  let stages: Stage[] = [];
  let stage: Stage = { argv: [] };
  const endStage = () => {
    if (!stage.argv.length) throw new ShellSyntaxError('syntax error: empty command');
    stages.push(stage);
    stage = { argv: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'word') {
      stage.argv.push(t.word);
      continue;
    }
    if (t.op === '>' || t.op === '>>' || t.op === '<') {
      const target = tokens[++i];
      if (target?.kind !== 'word') throw new ShellSyntaxError(`syntax error: expected a file after ${t.op}`);
      if (t.op === '<') stage.stdin = target.word;
      else stage.stdout = { target: target.word, append: t.op === '>>' };
    } else if (t.op === '|') {
      endStage();
    } else {
      if (!stage.argv.length && !stages.length && t.op === ';') continue;
      endStage();
      jobs.push({ stages, next: t.op as Job['next'] });
      stages = [];
    }
  }
  if (stage.argv.length || stages.length) {
    endStage();
    jobs.push({ stages, next: ';' });
  }
  return jobs;
}
