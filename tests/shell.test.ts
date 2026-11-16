import { describe, expect, it } from 'vitest';
import { parse, splitJobs, tokenize } from '../src/shell/parse';
import { globToRegExp, isInside, normalize, resolve } from '../src/kernel/vfs/path';
import { validate } from '../src/agent/schema';

const env = { HOME: '/home/user', NAME: 'world', '?': '7' };
const words = (line: string) => tokenize(line, env).map((t) => (t.kind === 'word' ? t.word.text : `<${t.op}>`));

describe('shell tokenizer', () => {
  it('handles quotes, escapes and variables', () => {
    expect(words(`echo "hi $NAME" '$NAME' a\\ b \${NAME}s $?`)).toEqual(['echo', 'hi world', '$NAME', 'a b', 'worlds', '7']);
  });
  it('expands ~ only at word start', () => {
    expect(words('ls ~ ~/x a~b')).toEqual(['ls', '/home/user', '/home/user/x', 'a~b']);
  });
  it('recognises operators and comments', () => {
    expect(words('a|b >> f # note')).toEqual(['a', '<|>', 'b', '<>>>', 'f']);
  });
  it('marks quoted words as not glob-expandable', () => {
    const t = tokenize('ls "*.txt" *.md', env);
    expect(t.map((x) => x.kind === 'word' && x.word.bare)).toEqual([true, false, true]);
  });
  it('rejects unterminated quotes', () => {
    expect(() => tokenize('echo "oops', env)).toThrow(/unterminated/);
  });
});

describe('shell parser', () => {
  it('builds pipelines with redirects', () => {
    const [job] = parse('cat < in.txt | sort > out.txt', env);
    expect(job!.stages).toHaveLength(2);
    expect(job!.stages[0]!.stdin?.text).toBe('in.txt');
    expect(job!.stages[1]!.stdout).toEqual({ target: { text: 'out.txt', bare: true }, append: false });
  });
  it('splits jobs lazily and ignores operators inside quotes', () => {
    expect(splitJobs(`a && b "x; y" || c; d`)).toEqual([
      { src: 'a ', next: '&&' },
      { src: ' b "x; y" ', next: '||' },
      { src: ' c', next: ';' },
      { src: ' d', next: ';' },
    ]);
  });
});

describe('paths', () => {
  it('normalizes and resolves', () => {
    expect(normalize('/a/./b/../c//')).toBe('/a/c');
    expect(normalize('/../..')).toBe('/');
    expect(resolve('/home/agent', '../user/x')).toBe('/home/user/x');
    expect(resolve('/home/agent', '/etc')).toBe('/etc');
  });
  it('checks containment without prefix confusion', () => {
    expect(isInside('/home/agent', '/home/agent/x')).toBe(true);
    expect(isInside('/home/agent', '/home/agent2/x')).toBe(false);
    expect(isInside('/home/agent', '/home/agent/../user')).toBe(false);
  });
  it('compiles globs', () => {
    expect(globToRegExp('/a/**/*.ts').test('/a/b/c/d.ts')).toBe(true);
    expect(globToRegExp('/a/**/*.ts').test('/a/d.ts')).toBe(true);
    expect(globToRegExp('/a/*.ts').test('/a/b/d.ts')).toBe(false);
    expect(globToRegExp('/a/*.{js,css}').test('/a/x.css')).toBe(true);
  });
});

describe('tool input validation', () => {
  const schema = { type: 'object' as const, properties: { path: { type: 'string' }, n: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['path'], additionalProperties: false };
  it('accepts valid input', () => expect(validate(schema, { path: 'x', n: 2, mode: 'a' })).toEqual([]));
  it('reports every problem', () => {
    expect(validate(schema, { n: 1.5, mode: 'z', extra: 1 })).toHaveLength(4);
    expect(validate(schema, 'nope')).toHaveLength(1);
  });
});
