/** ANSI SGR colour codes understood by the Terminal app. */
export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Removes colour codes and applies carriage returns, giving the text a program would read. */
export function plainText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1))
    .join('\n');
}
