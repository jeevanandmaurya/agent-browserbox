import type { Kernel } from '@/kernel/api';
import { looksBinary } from '@/apps/files/filetypes';
import { resolve } from '@/kernel/vfs/path';
import { h } from '@/ui/dom';
import { icon } from './icons';

const MAX_INLINE = 30 * 1024;
const MAX_TOTAL = 120 * 1024;
const TOKEN = /(^|\s)@([^\s@]*)$/;

/** Fuzzy match: every character of the query in order; earlier and basename matches rank higher. */
function score(path: string, q: string): number {
  if (!q) return 1;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 1000 - base.length;
  if (base.includes(q)) return 800 - base.length;
  if (lower.includes(q)) return 600 - lower.length;
  let i = 0;
  for (const c of lower) if (c === q[i]) i++;
  return i === q.length ? 300 - lower.length : -1;
}

/**
 * Typing @ in the message box lists files in the agent's working folder;
 * picking one inserts @path. On send, the files' contents go with the message.
 */
export function mentionMenu(os: Kernel, input: HTMLTextAreaElement, cwd: () => string) {
  const menu = h('div', { class: 'popover sc-menu mn-menu', role: 'listbox', 'aria-label': 'Files', hidden: true });
  let files: string[] = [];
  let loadedAt = 0;
  let shown: string[] = [];
  let index = 0;

  async function load(): Promise<void> {
    if (Date.now() - loadedAt < 15_000) return;
    loadedAt = Date.now();
    const base = cwd();
    const all = await os.fs.glob('**/*', base, 4000).catch(() => []);
    files = all
      .map((p) => (p.startsWith(base + '/') ? p.slice(base.length + 1) : p))
      .filter((p) => !p.split('/').some((part) => part.startsWith('.') || part === 'node_modules'));
  }

  const query = () => TOKEN.exec(input.value.slice(0, input.selectionStart ?? input.value.length));

  function render(): void {
    const m = query();
    if (!m) {
      menu.hidden = true;
      return;
    }
    const q = m[2]!.toLowerCase();
    shown = files
      .map((f) => [f, score(f, q)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f]) => f);
    menu.hidden = !shown.length;
    if (menu.hidden) return;
    index = Math.min(index, shown.length - 1);
    menu.replaceChildren(
      ...shown.map((f, i) =>
        h(
          'button',
          { class: 'pop-item sc-item', type: 'button', role: 'option', 'aria-selected': String(i === index), onpointerdown: (e: Event) => e.preventDefault(), onclick: () => pick(f) },
          icon('file', 15),
          h('span', { class: 'sc-name' }, f.slice(f.lastIndexOf('/') + 1)),
          h('span', { class: 'sc-desc' }, f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''),
        ),
      ),
    );
  }

  function pick(f: string): void {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret).replace(/@[^\s@]*$/, `@${f} `);
    input.value = before + input.value.slice(caret);
    input.setSelectionRange(before.length, before.length);
    input.dispatchEvent(new Event('input'));
    menu.hidden = true;
    input.focus();
  }

  input.addEventListener('input', () => {
    if (query()) void load().then(render);
    else menu.hidden = true;
  });
  input.addEventListener('blur', () => (menu.hidden = true));

  return {
    el: menu,
    key(e: KeyboardEvent): boolean {
      if (menu.hidden) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        index = (index + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        render();
        return true;
      }
      // Enter after a complete @path sends the message rather than completing it again.
      if (e.key === 'Enter' && !e.shiftKey && shown.includes(query()?.[2] ?? '')) {
        menu.hidden = true;
        return false;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        pick(shown[index]!);
        return true;
      }
      if (e.key === 'Escape') {
        menu.hidden = true;
        return true;
      }
      return false;
    },
  };
}

/**
 * Adds the contents of @mentioned files to a message, so the model sees them
 * without a read_file call. Large and binary files are named, not inlined.
 */
export async function attachMentions(os: Kernel, text: string, cwd: string): Promise<string> {
  const seen = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const m of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const path = resolve(cwd, m[2]!.replace(/[.,;:!?)]+$/, ''));
    if (seen.has(path)) continue;
    const st = await os.fs.stat(path).catch(() => null);
    if (st?.kind !== 'file') continue;
    seen.add(path);
    if (st.size > MAX_INLINE || total + st.size > MAX_TOTAL) {
      blocks.push(`<file path="${path}" size="${st.size}" note="too large to include; read it with read_file" />`);
      continue;
    }
    const bytes = await os.fs.readFile(path);
    if (looksBinary(bytes)) {
      blocks.push(`<file path="${path}" size="${st.size}" note="binary" />`);
      continue;
    }
    total += st.size;
    blocks.push(`<file path="${path}">\n${new TextDecoder().decode(bytes)}\n</file>`);
  }
  return blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text;
}
