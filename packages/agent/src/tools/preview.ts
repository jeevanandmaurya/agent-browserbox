import { imageRef } from '../images.js';
import { obj, tool, type ToolDef } from './types.js';

type Args = { action: string; target?: string; ref?: number | string; selector?: string; text?: string; value?: string; key?: string; code?: string; submit?: boolean; timeout?: number; amount?: number; checked?: boolean };

const ACTIONS = ['open', 'snapshot', 'click', 'type', 'select', 'check', 'press', 'scroll', 'wait', 'eval', 'console', 'screenshot', 'close'];

/**
 * Use a web page the way a person does, to check an app you built: open it,
 * read it, click, type, look at it. The page runs sandboxed in a window, as in
 * Preview, so it can only touch itself.
 */
export const previewTools: ToolDef[] = [
  tool<Args>({
    name: 'preview',
    description: `Use a web page you built as a person would, to test it: open a file of the box (an .html file or a site folder) or a dev server page (http://localhost:<port>/…, from dev_server), then read it and act on it.
Actions:
- open {target}: load the page; returns what is on it
- snapshot: the page as text; interactive elements are numbered [n]
- click {ref | selector | text}, type {ref | selector, value, submit?}, select {ref, value}, check {ref, checked}, press {key} (Enter, Escape, ArrowDown, a letter…), scroll {ref? | amount?}
- wait {selector | text, timeout?}: until something appears
- eval {code}: run JavaScript in the page and get the value (e.g. document.querySelectorAll('li').length)
- console: what the page logged since the last time, errors included
- screenshot: a picture of the page (1280×800), shown to you
- close
After acting, take a snapshot (or a screenshot) to see the result. Errors the page throws are reported with each action.`,
    input_schema: obj(
      {
        action: { type: 'string', enum: ACTIONS },
        target: { type: 'string', description: 'open: a file path or http://localhost:<port>/path' },
        ref: { type: 'integer', description: 'an element number [n] from the latest snapshot' },
        selector: { type: 'string', description: 'a CSS selector, instead of ref' },
        text: { type: 'string', description: 'visible text to find an element by (click), or to wait for' },
        value: { type: 'string', description: 'type: the text; select: the option' },
        submit: { type: 'boolean', description: 'type: press Enter afterwards' },
        checked: { type: 'boolean' },
        key: { type: 'string' },
        code: { type: 'string', description: 'eval: JavaScript (an expression, or statements with return)' },
        timeout: { type: 'integer', description: 'wait: milliseconds (default 5000)' },
        amount: { type: 'integer', description: 'scroll: pixels' },
      },
      ['action'],
    ),
    // Only eval runs code of your choosing; the rest uses the page the way a person would.
    cap: (i) => (i.action === 'eval' ? 'exec' : null),
    describe: (i) => (i.action === 'open' ? `Open ${i.target ?? ''} in the preview` : i.action === 'eval' ? `Run in the page: ${i.code ?? ''}` : `Preview: ${i.action}${i.ref ? ` [${i.ref}]` : i.selector ? ` ${i.selector}` : i.text ? ` "${i.text}"` : ''}${i.value ? ` "${i.value}"` : ''}`),
    async run(i, tc) {
      if (!tc.os.preview) throw new Error('no window is connected to show pages');
      if (!ACTIONS.includes(i.action)) throw new Error(`unknown action ${i.action}: ${ACTIONS.join(', ')}`);
      const args: Record<string, unknown> = { ...i };
      delete args.action;
      if (i.action === 'open') args.target = /^https?:/.test(i.target ?? '') ? i.target : tc.path(i.target ?? '');
      if (i.action === 'check') args.value = i.checked ?? true;
      const r = await tc.os.preview(tc.session, i.action, args);
      if (r.image) return { text: r.text, images: [await imageRef(tc.os, r.image)] };
      return r.text;
    },
  }),
];
