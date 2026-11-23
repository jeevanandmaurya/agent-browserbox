import { h } from '@/ui/dom';

export const DOCS = '/home/user/Documents';

export interface Tab {
  el: HTMLElement;
  setActive(on: boolean): void;
  dispose(): void;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Turns a user-typed name into a safe file stem. */
export function safeName(name: string): string {
  return name.trim().replace(/\.wgsl$/i, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * A monospace code textarea. Tab indents; press Escape first to move focus
 * out with Tab, so keyboard users are never trapped.
 */
export function codeEditor(label: string, onInput: () => void, onSave?: () => void): HTMLTextAreaElement {
  let escaped = false;
  const ta = h('textarea', {
    class: 'textarea gl-code',
    autocapitalize: 'off',
    autocomplete: 'off',
    wrap: 'off',
    'aria-label': label,
    title: 'Tab indents. Press Esc, then Tab, to leave the editor.',
    oninput: onInput,
  });
  ta.spellcheck = false; // h() skips `false` props, so set it directly
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      escaped = true;
      return;
    }
    if (e.key === 'Tab' && !escaped && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      onInput();
    } else if (onSave && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
    }
    escaped = false;
  });
  return ta;
}

/** Moves the caret to a 1-based line in a textarea and scrolls it into view. */
export function gotoLine(ta: HTMLTextAreaElement, line: number, col = 1): void {
  const lines = ta.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += (lines[i]?.length ?? 0) + 1;
  const end = pos + (lines[line - 1]?.length ?? 0);
  ta.focus();
  ta.setSelectionRange(Math.min(pos + Math.max(0, col - 1), end), end);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  ta.scrollTop = Math.max(0, (line - 3) * lh);
}

export function gpuHelp(reason: string): HTMLElement {
  return h(
    'div',
    { class: 'empty gl-unsupported' },
    h(
      'div',
      { class: 'col', style: 'max-width:460px;align-items:center' },
      h('div', { class: 'gl-big', 'aria-hidden': 'true' }, '◈'),
      h('h2', null, 'WebGPU is required'),
      h('p', null, `GPU Lab runs shaders on your graphics card through WebGPU. ${reason}`),
      h(
        'ul',
        { class: 'gl-help' },
        h('li', null, 'Chrome or Edge 113+ on Windows, macOS and ChromeOS (on by default).'),
        h('li', null, 'Safari 26+ on macOS and iOS.'),
        h('li', null, 'Firefox 141+ on Windows.'),
        h('li', null, 'Linux / Android Chrome: enable chrome://flags/#enable-unsafe-webgpu (and Vulkan) and restart the browser.'),
      ),
      h('p', { class: 'muted' }, 'WebGPU also needs a secure context (https or localhost) and a GPU that is not blocklisted; check chrome://gpu.'),
    ),
  );
}
