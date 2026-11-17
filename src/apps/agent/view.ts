import type { AgentEvent } from '@/agent/agent';
import type { Msg } from '@/agent/types';
import type { PermDecision, PermRequest } from '@/kernel/perms';
import { fmtDuration, h } from '@/ui/dom';
import { renderMarkdown } from '@/ui/markdown';
import { approvalCard, askCard } from './cards';
import { icon } from './icons';
import { friendlyTool } from './tool-labels';

export { renderTodos } from './cards';

interface ToolCard {
  el: HTMLDetailsElement;
  status: HTMLElement;
  output: HTMLElement;
  text: string;
}

/**
 * The transcript: turns agent events into DOM. Streaming text is re-rendered
 * at most once per frame, and only the block currently being written.
 */
export class Transcript {
  readonly el = h('div', { class: 'ag-log', role: 'log', 'aria-live': 'polite' });
  #turn: HTMLElement | null = null;
  #turnText: string[] = [];
  #textEl: HTMLElement | null = null;
  #text = '';
  #thinkEl: HTMLElement | null = null;
  #statusEl: HTMLElement | null = null;
  #tools = new Map<string, ToolCard>();
  #dirty = false;
  #cost = 0;

  clear(): void {
    this.el.replaceChildren();
    this.#turn = this.#textEl = this.#thinkEl = this.#statusEl = null;
    this.#turnText = [];
    this.#tools.clear();
  }

  #scroll(force = false): void {
    const s = this.el.closest<HTMLElement>('.ag-scroll');
    if (s && (force || s.scrollHeight - s.scrollTop - s.clientHeight < 160)) s.scrollTop = s.scrollHeight;
  }

  #ensureTurn(): HTMLElement {
    if (!this.#turn) {
      this.#turn = h('div', { class: 'ag-msg assistant' });
      this.el.append(this.#turn);
    }
    return this.#turn;
  }

  /** Closes the assistant turn and gives it a copy button when it said anything. */
  #finishTurn(): void {
    this.#endBlock();
    const turn = this.#turn;
    const text = this.#turnText.join('\n\n').trim();
    if (turn && text && !turn.querySelector(':scope > .ag-actions')) {
      const label = h('span', { class: 'sr-only' }, 'Copy response');
      const btn = h(
        'button',
        {
          class: 'icon-btn ag-copy',
          type: 'button',
          title: 'Copy',
          onclick: () =>
            void navigator.clipboard?.writeText(text).then(() => {
              btn.replaceChildren(icon('check', 15), label);
              setTimeout(() => btn.replaceChildren(icon('copy', 15), label), 1400);
            }),
        },
        icon('copy', 15),
        label,
      );
      turn.append(h('div', { class: 'ag-actions' }, btn));
    }
    this.#turn = null;
    this.#turnText = [];
  }

  #endBlock(): void {
    this.#flush();
    if (this.#textEl && this.#text) this.#turnText.push(this.#text);
    this.#textEl = this.#thinkEl = null;
    this.#text = '';
  }

  #flush(): void {
    if (this.#dirty && this.#textEl) this.#textEl.replaceChildren(renderMarkdown(this.#text));
    this.#dirty = false;
  }

  #setStatus(text: string): void {
    this.#statusEl?.remove();
    this.#statusEl = text ? h('div', { class: 'ag-status' }, h('span', { class: 'ag-spinner' }), h('span', null, text)) : null;
    if (this.#statusEl) this.el.append(this.#statusEl);
  }

  #place = (el: HTMLElement) => {
    this.#endBlock();
    // Whatever the agent does next goes below the card, in a continuation of this turn.
    this.#turn = null;
    this.el.append(el);
    this.#statusEl && this.el.append(this.#statusEl);
    this.#scroll(true);
  };

  addUser(text: string): void {
    this.#finishTurn();
    this.el.append(h('div', { class: 'ag-msg user' }, h('div', { class: 'ag-bubble' }, text)));
    this.#setStatus('Thinking…');
    this.#scroll(true);
  }

  addNote(text: string, kind: 'note' | 'error' = 'note', action?: { label: string; run: () => void }): void {
    this.#endBlock();
    this.el.append(h('div', { class: `ag-note ${kind}` }, icon(kind === 'error' ? 'info' : 'spark', 16), h('span', null, text), action ? h('button', { class: 'btn small', type: 'button', onclick: action.run }, action.label) : null));
    this.#scroll();
  }

  ask(question: string, options: string[] = []): Promise<string> {
    return askCard(question, options, this.#place);
  }

  approve(req: PermRequest, signal?: AbortSignal): Promise<PermDecision> {
    return approvalCard(req, signal, this.#place);
  }

  #toolCard(id: string, name: string, summary: string, input: unknown): ToolCard {
    const status = h('span', { class: 'ag-tool-status' }, h('span', { class: 'ag-spinner' }));
    const output = h('pre', { class: 'ag-tool-out' });
    const line = summary.split('\n')[0]!.slice(0, 200);
    const el = h(
      'details',
      { class: 'ag-tool' },
      h(
        'summary',
        null,
        status,
        h('span', { class: 'ag-tool-name' }, name),
        h('span', { class: 'ag-tool-friendly' }, friendlyTool(name, line)),
        h('span', { class: 'ag-tool-sum' }, line),
        h('span', { class: 'ag-tool-chev' }, icon('chevron', 14)),
      ),
      h('div', { class: 'ag-tool-body' }, h('div', { class: 'ag-tool-label' }, 'Input'), h('pre', { class: 'ag-tool-in' }, typeof input === 'string' ? input : JSON.stringify(input, null, 2)), h('div', { class: 'ag-tool-label' }, 'Output'), output),
    );
    const card = { el, status, output, text: '' };
    this.#tools.set(id, card);
    this.#ensureTurn().append(el);
    return card;
  }

  #finishTool(card: ToolCard, result: string, isError: boolean, ms?: number): void {
    card.output.textContent = result.length > 20000 ? result.slice(0, 20000) + '\n… (truncated in view)' : result;
    card.status.replaceChildren(icon(isError ? 'close' : 'check', 13));
    card.el.classList.add(isError ? 'err' : 'ok');
    if (ms !== undefined) card.el.querySelector('.ag-tool-chev')!.before(h('span', { class: 'ag-tool-ms' }, fmtDuration(ms)));
  }

  handle(e: AgentEvent): void {
    switch (e.type) {
      case 'text':
        this.#setStatus('');
        if (!this.#textEl) {
          this.#endBlock();
          this.#textEl = h('div', { class: 'ag-text md' });
          this.#ensureTurn().append(this.#textEl);
        }
        this.#text += e.delta;
        if (!this.#dirty) {
          this.#dirty = true;
          // Re-rendering Markdown gets slower as a reply grows. Wait three times
          // as long as the last render took, so it never uses more than about a
          // quarter of a slow phone's time; short replies still update every frame.
          setTimeout(
            () =>
              requestAnimationFrame(() => {
                const t = performance.now();
                this.#flush();
                this.#cost = performance.now() - t;
                this.#scroll();
              }),
            this.#cost > 4 ? Math.min(this.#cost * 3, 400) : 0,
          );
        }
        break;
      case 'thinking':
        this.#setStatus('');
        if (!this.#thinkEl) {
          this.#endBlock();
          this.#thinkEl = h('div', { class: 'ag-think-body' });
          this.#ensureTurn().append(thinkBlock(this.#thinkEl));
        }
        this.#thinkEl.append(e.delta);
        break;
      case 'status':
        this.#setStatus(e.text);
        this.#scroll();
        break;
      case 'tool_start':
        this.#setStatus('');
        this.#endBlock();
        this.#toolCard(e.id, e.name, e.summary, e.input);
        this.#scroll();
        break;
      case 'tool_progress': {
        const card = this.#tools.get(e.id);
        if (card && card.text.length < 20000) {
          card.text += e.chunk;
          card.output.textContent = card.text;
        }
        break;
      }
      case 'tool_end': {
        const card = this.#tools.get(e.id);
        if (card) this.#finishTool(card, e.result, e.isError, e.ms);
        this.#setStatus('Thinking…');
        break;
      }
      case 'note':
        this.addNote(e.text);
        break;
      case 'done':
        this.#setStatus('');
        this.#finishTurn();
        break;
      default:
        break;
    }
  }

  /** Rebuilds the view from a saved conversation. */
  restore(messages: Msg[]): void {
    this.clear();
    for (const m of messages) {
      if (m.role === 'user') {
        for (const b of m.content) {
          if (b.type === 'text') {
            this.#finishTurn();
            this.el.append(h('div', { class: 'ag-msg user' }, h('div', { class: 'ag-bubble' }, b.text)));
          } else if (b.type === 'tool_result') {
            const card = this.#tools.get(b.tool_use_id);
            if (card) this.#finishTool(card, b.content, b.is_error ?? false);
          }
        }
      } else {
        const turn = this.#ensureTurn();
        for (const b of m.content) {
          if (b.type === 'text') {
            turn.append(h('div', { class: 'ag-text md' }, renderMarkdown(b.text)));
            this.#turnText.push(b.text);
          } else if (b.type === 'thinking') turn.append(thinkBlock(h('div', { class: 'ag-think-body' }, b.text)));
          else if (b.type === 'tool_use') this.#toolCard(b.id, b.name, summarize(b.input), b.input);
          else if (b.type === 'server_note') turn.append(h('div', { class: 'ag-note' }, b.text));
        }
      }
    }
    for (const card of this.#tools.values()) if (!card.el.classList.contains('ok') && !card.el.classList.contains('err')) this.#finishTool(card, '(no result recorded)', true);
    this.#finishTurn();
    this.#scroll(true);
  }
}

function thinkBlock(body: HTMLElement): HTMLElement {
  return h('details', { class: 'ag-think' }, h('summary', null, icon('spark', 14), h('span', null, 'Thinking'), icon('chevron', 14)), body);
}

function summarize(input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.pattern ?? input.url ?? input.question ?? input.task ?? input.app ?? input.code ?? '';
  return String(v);
}
