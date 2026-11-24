import type { AgentEvent } from '@jeevanand/agent-browserbox/ui';
import type { PermDecision, PermRequest } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * A small always-on-top window (Document Picture-in-Picture) showing what the
 * agent is doing while you work in another app: its steps as they happen, and
 * approvals you can answer right there.
 */
type Pip = { requestWindow(o: { width: number; height: number }): Promise<Window>; window: Window | null };
const api = (): Pip | null => (globalThis as { documentPictureInPicture?: Pip }).documentPictureInPicture ?? null;
export const pipAvailable = (): boolean => api() !== null;

const CSS = `
:root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e4e4df; --accent: #c2410c; --ok: #15803d; --err: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #a3a39e; --line: #2c2c2a; --accent: #fb923c; --ok: #4ade80; --err: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
header { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: center; }
header strong { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { font-size: 12px; color: var(--muted); }
.state.working { color: var(--accent); }
.state.waiting { color: var(--err); font-weight: 600; }
ol { list-style: none; margin: 0; padding: 8px 12px; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
li { color: var(--muted); overflow-wrap: anywhere; }
li.tool::before { content: '◦ '; }
li.ok::before { content: '✓ '; color: var(--ok); }
li.bad::before { content: '✗ '; color: var(--err); }
li.say { color: var(--fg); }
.card { margin: 8px 12px 12px; padding: 10px; border: 1px solid var(--accent); border-radius: 10px; }
.card p { margin: 0 0 4px; }
.card code { display: block; font: 12px ui-monospace, monospace; background: color-mix(in srgb, var(--fg) 7%, transparent); padding: 6px; border-radius: 6px; margin: 6px 0; white-space: pre-wrap; max-height: 120px; overflow: auto; }
.row { display: flex; gap: 6px; justify-content: flex-end; }
button { font: inherit; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`;

export class MiniView {
  #win: Window | null = null;
  #title = 'Agent';
  #list: HTMLOListElement | null = null;
  #state: HTMLElement | null = null;
  #head: HTMLElement | null = null;
  #cardSlot: HTMLElement | null = null;
  #tools = new Map<string, HTMLLIElement>();
  #say: HTMLLIElement | null = null;

  get open(): boolean {
    return !!this.#win && !this.#win.closed;
  }

  async show(title: string): Promise<void> {
    const pip = api();
    if (!pip) throw new Error('This browser has no Picture-in-Picture for pages.');
    if (this.open) return void this.#win!.focus();
    const win = await pip.requestWindow({ width: 360, height: 420 });
    this.#win = win;
    const d = win.document;
    d.title = 'BrowserBox agent';
    const style = d.createElement('style');
    style.textContent = CSS;
    d.head.append(style);
    this.#head = d.createElement('strong');
    this.#state = d.createElement('span');
    this.#state.className = 'state';
    const header = d.createElement('header');
    header.append(this.#head, this.#state);
    this.#list = d.createElement('ol');
    this.#list.setAttribute('aria-live', 'polite');
    this.#cardSlot = d.createElement('div');
    d.body.append(header, this.#list, this.#cardSlot);
    win.addEventListener('pagehide', () => (this.#win = null));
    this.setTitle(title);
    this.#setState('idle');
  }

  close(): void {
    this.#win?.close();
    this.#win = null;
  }

  setTitle(title: string): void {
    this.#title = title || 'Agent';
    if (this.#head) this.#head.textContent = this.#title;
  }

  #setState(s: 'idle' | 'working' | 'waiting' | 'done' | 'failed'): void {
    if (!this.#state) return;
    this.#state.className = `state ${s}`;
    this.#state.textContent = { idle: 'Idle', working: 'Working…', waiting: 'Needs you', done: 'Done', failed: 'Stopped' }[s];
  }

  #add(cls: string, text: string): HTMLLIElement | null {
    if (!this.#list || !this.#win) return null;
    const li = this.#win.document.createElement('li');
    li.className = cls;
    li.textContent = text;
    this.#list.append(li);
    while (this.#list.children.length > 60) this.#list.firstElementChild!.remove();
    li.scrollIntoView({ block: 'end' });
    return li;
  }

  /** Follows the chat's events. */
  event(e: AgentEvent): void {
    if (!this.open) return;
    if (e.type === 'start') {
      this.#setState('working');
      this.#say = null;
    } else if (e.type === 'tool_start') {
      this.#say = null;
      const li = this.#add('tool', e.summary || e.name);
      if (li) this.#tools.set(e.id, li);
    } else if (e.type === 'tool_end') {
      const li = this.#tools.get(e.id);
      if (li) li.className = e.isError ? 'bad' : 'ok';
      this.#tools.delete(e.id);
    } else if (e.type === 'text') {
      this.#say ??= this.#add('say', '');
      if (this.#say) this.#say.textContent = `${this.#say.textContent}${e.delta}`.slice(-400);
    } else if (e.type === 'error') this.#add('bad', e.message);
    else if (e.type === 'done') {
      this.#setState(e.reason === 'end' ? 'done' : 'failed');
      this.#say = null;
    }
  }

  /** Offers an approval here too; null when the window is not open. Aborting removes it. */
  approve(req: PermRequest, signal: AbortSignal): Promise<PermDecision> | null {
    if (!this.open || !this.#cardSlot) return null;
    const d = this.#win!.document;
    this.#setState('waiting');
    return new Promise<PermDecision>((resolve) => {
      const card = d.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', 'Permission request');
      const p = d.createElement('p');
      p.textContent = `${req.actor || 'The agent'} wants to: ${req.title}`;
      const code = d.createElement('code');
      code.textContent = req.detail;
      const row = d.createElement('div');
      row.className = 'row';
      const finish = (v: PermDecision) => {
        card.remove();
        this.#setState('working');
        resolve(v);
      };
      for (const [label, value, primary] of [['Deny', 'deny', false], ['Allow once', 'once', true]] as const) {
        const b = d.createElement('button');
        b.textContent = label;
        if (primary) b.className = 'primary';
        b.addEventListener('click', () => finish(value));
        row.append(b);
      }
      card.append(p, code, row);
      this.#cardSlot!.replaceChildren(card);
      signal.addEventListener('abort', () => {
        card.remove();
        if (this.#state?.classList.contains('waiting')) this.#setState('working');
      });
    });
  }

  /** The agent asked a question: say so (answers are typed in the main window). */
  asked(question: string): void {
    if (!this.open) return;
    this.#setState('waiting');
    this.#add('say', `Asks: ${question} (answer in the BrowserBox window)`);
  }
}
