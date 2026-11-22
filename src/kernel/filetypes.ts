/** File classification: kinds, languages and MIME types. DOM-free; shared by the dev server and the Files, Editor and Preview apps. */
import { basename, extname } from '@/kernel/vfs/path';

export type FileKind = 'dir' | 'text' | 'code' | 'markdown' | 'html' | 'image' | 'svg' | 'audio' | 'video' | 'pdf' | 'archive' | 'binary';

const LANGS: Record<string, string> = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript (JSX)',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript (TSX)',
  py: 'Python', json: 'JSON', jsonl: 'JSON Lines', css: 'CSS', scss: 'SCSS', less: 'Less',
  html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG', md: 'Markdown', markdown: 'Markdown',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', ini: 'INI',
  csv: 'CSV', tsv: 'TSV', sql: 'SQL', rs: 'Rust', go: 'Go', c: 'C', h: 'C', cpp: 'C++', cc: 'C++',
  hpp: 'C++', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP', swift: 'Swift', lua: 'Lua',
  r: 'R', wat: 'WebAssembly Text', vue: 'Vue', svelte: 'Svelte', txt: 'Plain Text', log: 'Log',
};

const PLAIN = new Set(['txt', 'log', 'csv', 'tsv', 'env', 'conf', 'cfg', 'gitignore', 'gitattributes', 'editorconfig', 'lock', 'properties', 'rst', 'tex', 'diff', 'patch']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);

export function kindOf(name: string, isDir = false): FileKind {
  if (isDir) return 'dir';
  const ext = extname(name);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE.has(ext)) return 'image';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';
  if (ARCHIVE.has(ext)) return 'archive';
  if (PLAIN.has(ext)) return 'text';
  if (ext in LANGS) return 'code';
  // Extensionless files (README, Makefile, /proc entries) and dotfiles are usually text.
  if (!ext || basename(name).startsWith('.')) return 'text';
  return 'binary';
}

/** Whether a file opens in the Editor; everything else goes to Preview. */
export function isTextLike(name: string): boolean {
  const k = kindOf(name);
  return k === 'text' || k === 'code' || k === 'markdown';
}

export function languageOf(name: string): string {
  return LANGS[extname(name)] ?? (kindOf(name) === 'text' ? 'Plain Text' : extname(name).toUpperCase() || 'Plain Text');
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mov: 'video/quicktime', m4v: 'video/mp4', pdf: 'application/pdf',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', xml: 'application/xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
};

export function mimeOf(name: string): string {
  return MIME[extname(name)] ?? (isTextLike(name) ? 'text/plain' : 'application/octet-stream');
}

/** NUL bytes are a reliable enough "this is binary" signal; `limit` bounds the scan. */
export function looksBinary(bytes: Uint8Array, limit = 8192): boolean {
  return bytes.subarray(0, limit).includes(0);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
