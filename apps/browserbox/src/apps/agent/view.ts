import type { AgentEvent } from '@jeevanand/agent-browserbox/ui';
import { isImagePath, MODE_TAG } from '@jeevanand/agent-browserbox/ui';
import type { FileDiff } from '@jeevanand/agent-browserbox/ui';
import type { Msg } from '@jeevanand/agent-browserbox/ui';
import type { PermDecision, PermRequest } from '@jeevanand/agent-browserbox-runtime/client';
import { fmtDuration, h } from '@/ui/dom';
import { loader } from '@/ui/icons';
import { renderMarkdown } from '@/ui/markdown';
import { approvalCard, askCard } from './cards';
import { fmtSpeed, fmtTokens } from './context-meter';
import { diffStat, diffView } from './diffview';
import { icon } from './icons';

/** Files attached with @mentions travel inside the message; the chat shows them as chips. */
const FILE_BLOCK = /\n*<file path="([^"]+)"[^>]*?(?:\/>|>[\s\S]*?<\/file>)/g;
/** Uploads are listed at the end of the message (see the composer). */
const UPLOADS = /\n*Attached files:\n((?:- [^\n]+\n?)+)\s*$/;

/** What a user message looks like in the chat: without hidden instructions and attached file contents. */
export function forDisplay(text: string): { text: string; files: string[]; uploads: string[]; plan: boolean } {
  const plan = MODE_TAG.test(text);
  text = text.replace(MODE_TAG, '');
  const uploads = text.match(UPLOADS)?.[1]?.split('\n').flatMap((l) => (l.startsWith('- ') ? [l.slice(2).trim()] : [])) ?? [];
  const files = [...[...text.matchAll(FILE_BLOCK)].map((m) => m[1]!), ...uploads];
  return { text: text.replace(UPLOADS, '').replace(FILE_BLOCK, '').trim(), files, uploads, plan };
}

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
  /** Model calls in the current reply: their tokens and timing. */
  #stats: { calls: number; context: number; output: number; timedOutput: number; ms: number; genMs: number; ttft: number } | null = null;
  #textEl: HTMLElement | null = null;
  #text = '';
  #thinkEl: HTMLElement | null = null;
  #statusEl: HTMLElement | null = null;
  #tools = new Map<string, ToolCard>();
  #dirty = false;
  #cost = 0;
  #diffs = new Map<string, FileDiff>();
  /** Opens an artifact (its id and version). */
  onOpenArtifact: ((id: string, version: number) => void) | null = null;
  /** Opens a sub-agent's work (its spawn_agent call id and summary). */
  onOpenSubagent: ((id: string, title: string) => void) | null = null;
  /** Reads a file from the box, to show attached images. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Called with the message's position among your messages (0 = first) and its text, to edit and resend it. */
  onEdit: ((ordinal: number, text: string) => void) | null = null;

  clear(): void {
    this.el.replaceChildren();
    this.#turn = this.#textEl = this.#thinkEl = this.#statusEl = null;
    this.#turnText = [];
    this.#tools.clear();
    this.#diffs.clear();
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
    // Tokens and speed for the reply, next to its actions.
    const st = this.#stats;
    if (st) {
      // A reply that ended after a tool card has no open turn: the stats go on a row of their own.
      let row = turn?.querySelector<HTMLElement>(':scope > .ag-actions') ?? null;
      if (!row) {
        row = h('div', { class: 'ag-actions' });
        if (turn) turn.append(row);
        else this.el.append(h('div', { class: 'ag-msg assistant' }, row));
      }
      const tps = st.genMs > 0 && st.timedOutput ? st.timedOutput / (st.genMs / 1000) : 0;
      row.append(
        h(
          'span',
          { class: 'ag-stats', title: `${st.calls} model call${st.calls === 1 ? '' : 's'} · first token after ${fmtDuration(st.ttft)} · ${st.output.toLocaleString()} tokens written · ${st.context.toLocaleString()} tokens in context at the end` },
          `${fmtDuration(st.ms)}${tps ? ` · ${fmtSpeed(tps)}` : ''} · ${fmtTokens(st.output)} out · ${fmtTokens(st.context)} context`,
        ),
      );
    }
    this.#stats = null;
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
    this.#statusEl = text ? h('div', { class: 'ag-status' }, loader(16, text), h('span', null, text)) : null;
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

  /** An attached image, loaded from the box; a file chip when it cannot be read. */
  #thumb(path: string): HTMLElement {
    const name = path.split('/').pop() ?? path;
    const el = h('span', { class: 'ag-file-chip', title: path }, icon('file', 13), name);
    const full = path.startsWith('/') ? path : `/home/agent/${path}`;
    void this.readFile?.(full)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        const img = h('img', { class: 'ag-thumb', src: url, alt: name, title: path, onload: () => URL.revokeObjectURL(url) });
        el.replaceWith(img);
      })
      .catch(() => undefined);
    return el;
  }

  #userMsg(raw: string): HTMLElement {
    const { text, files, uploads, plan } = forDisplay(raw);
    // Editing keeps the uploads: they go back into the message as the composer wrote them.
    const editable = uploads.length ? `${text}\n\nAttached files:\n${uploads.map((u) => `- ${u}`).join('\n')}` : text;
    const el = h(
      'div',
      { class: 'ag-msg user' },
      plan ? h('span', { class: 'ag-mode-tag' }, icon('fileText', 13), 'Plan') : null,
      h('div', { class: 'ag-bubble' }, text),
      files.length ? h('div', { class: 'ag-attach' }, files.map((f) => (isImagePath(f) ? this.#thumb(f) : h('span', { class: 'ag-file-chip', title: f }, icon('file', 13), f.split('/').pop())))) : null,
    );
    const copyBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Copy', 'aria-label': 'Copy message', onclick: () => void navigator.clipboard?.writeText(text) }, icon('copy', 15));
    const editBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Edit and resend from here', 'aria-label': 'Edit message', onclick: () => this.onEdit?.([...this.el.querySelectorAll('.ag-msg.user')].indexOf(el), editable) }, icon('edit', 15));
    el.append(h('div', { class: 'ag-user-actions' }, editBtn, copyBtn));
    return el;
  }

  /** A note with buttons, e.g. after a plan: run it, or keep planning. */
  addChoices(text: string, actions: Array<{ label: string; primary?: boolean; run: () => void }>): void {
    this.#finishTurn();
    const box = h('div', { class: 'ag-choices' }, h('span', null, text));
    const row = h('div', { class: 'ag-choice-row' });
    for (const a of actions) row.append(h('button', { class: `btn small${a.primary ? ' primary' : ''}`, type: 'button', onclick: () => (box.remove(), a.run()) }, a.label));
    box.append(row);
    this.el.append(box);
    this.#scroll(true);
  }

  addUser(text: string): void {
    this.#finishTurn();
    this.el.querySelectorAll('.ag-choices').forEach((c) => c.remove());
    this.el.append(this.#userMsg(text));
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
    const status = h('span', { class: 'ag-tool-status' }, loader(14, 'Running'));
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
        h('span', { class: 'ag-tool-sum' }, line),
        h('span', { class: 'ag-tool-chev' }, icon('chevron', 14)),
      ),
      h('div', { class: 'ag-tool-body' }, h('div', { class: 'ag-tool-label' }, 'Input'), h('pre', { class: 'ag-tool-in' }, typeof input === 'string' ? input : JSON.stringify(input, null, 2)), h('div', { class: 'ag-tool-label' }, 'Output'), output),
    );
    el.dataset.id = id;
    // A sub-agent's card opens what it did, step by step.
    if (name === 'spawn_agent' && this.onOpenSubagent) {
      const open = h('button', { class: 'btn small ag-sub-open', type: 'button', onclick: () => this.onOpenSubagent?.(id, line) }, 'Show what it did');
      el.querySelector('.ag-tool-body')!.append(open);
    }
    const card = { el, status, output, text: '' };
    this.#tools.set(id, card);
    this.#ensureTurn().append(el);
    return card;
  }

  #finishTool(card: ToolCard, result: string, isError: boolean, ms?: number): void {
    // An artifact the agent made or changed: a card that opens it.
    const art = !isError && /^(Created|Updated) artifact "(.*)" \(id: ([\w-]+), kind: (\w+), version (\d+)\)\.$/.exec(result);
    if (art && this.onOpenArtifact && !card.el.nextElementSibling?.classList.contains('ag-artifact')) {
      const [, verb, title, id, kind, version] = art;
      const open = () => this.onOpenArtifact?.(id!, Number(version));
      card.el.after(
        h(
          'button',
          { class: 'ag-artifact', type: 'button', onclick: open, title: 'Open' },
          icon(kind === 'html' ? 'globe' : kind === 'csv' ? 'grid' : kind === 'code' ? 'code' : kind === 'svg' || kind === 'mermaid' ? 'image' : 'fileText', 20),
          h('span', { class: 'ag-artifact-text' }, h('strong', null, title), h('span', { class: 'muted' }, `${verb === 'Created' ? 'New' : 'Updated'} · version ${version}`)),
          h('span', { class: 'ag-artifact-open' }, 'Open'),
        ),
      );
    }
    card.output.textContent = result.length > 20000 ? result.slice(0, 20000) + '\n… (truncated in view)' : result;
    card.status.replaceChildren(icon(isError ? 'close' : 'check', 13));
    card.el.classList.add(isError ? 'err' : 'ok');
    const diff = this.#diffs.get(card.el.dataset.id ?? '');
    if (diff && !isError && !card.el.querySelector('.df')) {
      card.el.querySelector('.ag-tool-sum')!.after(diffStat(diff));
      card.el.querySelector('.ag-tool-body')!.prepend(diffView(diff));
      card.el.classList.add('has-diff');
      // Small edits are shown straight away, as a reviewer would want.
      if (diff.hunks.reduce((n, hk) => n + hk.lines.length, 0) <= 40) card.el.open = true;
    }
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
      case 'hook': {
        // A quiet line per hook run; its output opens on click. A failed hook stands out.
        const failed = e.code !== 0 && e.code !== 2;
        const line = `hook · ${e.event} · ${e.command} · ${e.code === 2 ? 'blocked' : failed ? `failed (exit ${e.code})` : 'ok'} · ${Math.round(e.ms)} ms`;
        this.#ensureTurn().append(e.output ? h('details', { class: `ag-hook${failed ? ' err' : ''}` }, h('summary', null, line), h('pre', null, e.output)) : h('div', { class: `ag-hook${failed ? ' err' : ''}` }, line));
        break;
      }
      case 'file_change':
        this.#diffs.set(e.id, e.diff);
        break;
      case 'usage': {
        const st = (this.#stats ??= { calls: 0, context: 0, output: 0, timedOutput: 0, ms: 0, genMs: 0, ttft: 0 });
        if (!st.calls) st.ttft = e.stats.ttft;
        st.calls++;
        st.context = e.context.used;
        st.output += e.usage.output;
        st.ms += e.stats.ms;
        if (e.stats.tps) {
          st.genMs += (e.usage.output / e.stats.tps) * 1000;
          st.timedOutput += e.usage.output;
        }
        break;
      }
      case 'done':
        this.#setStatus('');
        this.#finishTurn();
        break;
      default:
        break;
    }
  }

  /** Rebuilds the view from a saved conversation. */
  restore(messages: Msg[], diffs: Record<string, FileDiff> = {}): void {
    this.clear();
    for (const [id, d] of Object.entries(diffs)) this.#diffs.set(id, d);
    for (const m of messages) {
      if (m.role === 'user') {
        for (const b of m.content) {
          if (b.type === 'text') {
            this.#finishTurn();
            this.el.append(this.#userMsg(b.text));
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
