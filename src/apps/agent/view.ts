import type { AgentEvent } from '@/agent/agent';
import type { TodoItem } from '@/agent/tools/index';
import type { Msg } from '@/agent/types';
import { fmtDuration, h } from '@/ui/dom';
import { renderMarkdown } from '@/ui/markdown';

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
  #textEl: HTMLElement | null = null;
  #text = '';
  #thinkEl: HTMLElement | null = null;
  #statusEl: HTMLElement | null = null;
  #tools = new Map<string, ToolCard>();
  #dirty = false;

  clear(): void {
    this.el.replaceChildren();
    this.#turn = this.#textEl = this.#thinkEl = this.#statusEl = null;
    this.#tools.clear();
  }

  #scroll(force = false): void {
    const s = this.el.parentElement;
    if (s && (force || s.scrollHeight - s.scrollTop - s.clientHeight < 160)) s.scrollTop = s.scrollHeight;
  }

  #ensureTurn(): HTMLElement {
    if (!this.#turn) {
      this.#turn = h('div', { class: 'ag-msg assistant' });
      this.el.append(this.#turn);
    }
    return this.#turn;
  }

  #endBlock(): void {
    this.#flush();
    this.#textEl = this.#thinkEl = null;
    this.#text = '';
  }

  #flush(): void {
    if (this.#dirty && this.#textEl) this.#textEl.replaceChildren(renderMarkdown(this.#text));
    this.#dirty = false;
  }

  #setStatus(text: string): void {
    this.#statusEl?.remove();
    this.#statusEl = text ? h('div', { class: 'ag-status' }, h('span', { class: 'ag-spinner' }), text) : null;
    if (this.#statusEl) this.el.append(this.#statusEl);
  }

  addUser(text: string): void {
    this.#endBlock();
    this.#turn = null;
    this.el.append(h('div', { class: 'ag-msg user' }, text));
    this.#setStatus('Thinking…');
    this.#scroll(true);
  }

  addNote(text: string, kind: 'note' | 'error' = 'note', action?: { label: string; run: () => void }): void {
    this.#endBlock();
    this.el.append(h('div', { class: `ag-note ${kind}` }, h('span', null, text), action ? h('button', { class: 'btn small', onclick: action.run }, action.label) : null));
    this.#scroll();
  }

  /** Inline question from the agent; resolves with the user's answer. */
  ask(question: string, options: string[] = []): Promise<string> {
    this.#endBlock();
    return new Promise((resolve) => {
      const input = h('input', { class: 'input', placeholder: 'Type an answer…', 'aria-label': 'Answer' });
      const answer = (value: string) => {
        if (!value.trim()) return;
        card.replaceChildren(h('div', { class: 'ag-q' }, question), h('div', { class: 'muted' }, `You answered: ${value}`));
        resolve(value);
      };
      const card = h(
        'form',
        {
          class: 'ag-ask card',
          onsubmit: (e: Event) => {
            e.preventDefault();
            answer(input.value);
          },
        },
        h('div', { class: 'ag-q' }, question),
        options.length ? h('div', { class: 'row ag-opts' }, options.map((o) => h('button', { class: 'btn', type: 'button', onclick: () => answer(o) }, o))) : null,
        h('div', { class: 'row' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Answer')),
      );
      this.el.append(card);
      this.#scroll(true);
      input.focus();
    });
  }

  #toolCard(id: string, name: string, summary: string, input: unknown): ToolCard {
    const status = h('span', { class: 'ag-tool-status' }, h('span', { class: 'ag-spinner' }));
    const output = h('pre', { class: 'ag-tool-out' });
    const el = h(
      'details',
      { class: 'ag-tool' },
      h('summary', null, status, h('span', { class: 'ag-tool-name' }, name), h('span', { class: 'ag-tool-sum' }, summary.split('\n')[0]!.slice(0, 200))),
      h('div', { class: 'ag-tool-body' }, h('div', { class: 'ag-tool-label' }, 'Input'), h('pre', { class: 'ag-tool-in' }, typeof input === 'string' ? input : JSON.stringify(input, null, 2)), h('div', { class: 'ag-tool-label' }, 'Output'), output),
    );
    const card = { el, status, output, text: '' };
    this.#tools.set(id, card);
    this.#ensureTurn().append(el);
    return card;
  }

  #finishTool(card: ToolCard, result: string, isError: boolean, ms?: number): void {
    card.output.textContent = result.length > 20000 ? result.slice(0, 20000) + '\n… (truncated in view)' : result;
    card.status.replaceChildren(isError ? '✕' : '✓');
    card.el.classList.add(isError ? 'err' : 'ok');
    if (ms !== undefined) card.el.querySelector('summary')!.append(h('span', { class: 'ag-tool-ms' }, fmtDuration(ms)));
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
          requestAnimationFrame(() => {
            this.#flush();
            this.#scroll();
          });
        }
        break;
      case 'thinking':
        this.#setStatus('');
        if (!this.#thinkEl) {
          this.#endBlock();
          this.#thinkEl = h('pre', { class: 'ag-think-body' });
          this.#ensureTurn().append(h('details', { class: 'ag-think' }, h('summary', null, 'Thinking'), this.#thinkEl));
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
        this.#endBlock();
        this.#setStatus('');
        this.#turn = null;
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
            this.#turn = null;
            this.el.append(h('div', { class: 'ag-msg user' }, b.text));
          } else if (b.type === 'tool_result') {
            const card = this.#tools.get(b.tool_use_id);
            if (card) this.#finishTool(card, b.content, b.is_error ?? false);
          }
        }
      } else {
        const turn = this.#ensureTurn();
        for (const b of m.content) {
          if (b.type === 'text') turn.append(h('div', { class: 'ag-text md' }, renderMarkdown(b.text)));
          else if (b.type === 'thinking') turn.append(h('details', { class: 'ag-think' }, h('summary', null, 'Thinking'), h('pre', { class: 'ag-think-body' }, b.text)));
          else if (b.type === 'tool_use') this.#toolCard(b.id, b.name, summarize(b.input), b.input);
          else if (b.type === 'server_note') turn.append(h('div', { class: 'ag-note' }, b.text));
        }
      }
    }
    for (const card of this.#tools.values()) if (!card.el.classList.contains('ok') && !card.el.classList.contains('err')) this.#finishTool(card, '(no result recorded)', true);
    this.#turn = null;
    this.#scroll(true);
  }
}

function summarize(input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.pattern ?? input.url ?? input.question ?? input.task ?? input.app ?? input.code ?? '';
  return String(v);
}

export function renderTodos(items: TodoItem[]): HTMLElement | null {
  if (!items.length) return null;
  const done = items.filter((t) => t.status === 'done').length;
  return h(
    'details',
    { class: 'ag-todos', open: done < items.length },
    h('summary', null, `Tasks ${done}/${items.length}`),
    h('ul', null, items.map((t) => h('li', { class: t.status }, h('span', { class: 'ag-todo-mark' }, t.status === 'done' ? '✓' : t.status === 'in_progress' ? '▸' : '○'), t.text))),
  );
}
