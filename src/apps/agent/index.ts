import './style.css';
import { Agent } from '@/agent/agent';
import { describeModel, loadConfig } from '@/agent/config';
import { deleteSession, listSessions, loadSession, saveSession, titleFrom } from '@/agent/session';
import type { AppModule } from '@/ui/apps';
import { fmtTime, h } from '@/ui/dom';
import { renderTodos, Transcript } from './view';

const SUGGESTIONS = [
  'Give me a tour: what can you do in this OS?',
  'Build a small interactive web page and show it to me',
  'Write a Python script that plots a sine wave, run it, and show the chart',
  'Benchmark a WebGPU compute shader against plain JavaScript',
];

const app: AppModule = {
  mount(ctx) {
    const { os, root, win } = ctx;
    const log = new Transcript();
    let agent: Agent;

    // --- layout ------------------------------------------------------------
    const modelBtn = h('button', { class: 'btn small ag-model', title: 'Change model', onclick: () => ctx.launch('settings', { section: 'model' }) });
    const usage = h('span', { class: 'muted ag-usage' });
    const sessions = h('div', { class: 'ag-sessions' });
    const side = h('aside', { class: 'ag-side' }, h('button', { class: 'btn primary', onclick: () => newSession() }, '+ New session'), sessions);
    const todoSlot = h('div', { class: 'ag-todo-slot' });
    const empty = h(
      'div',
      { class: 'ag-empty' },
      h('div', { class: 'ag-logo' }, '✦'),
      h('h2', null, 'What should we work on?'),
      h('p', { class: 'muted' }, 'The agent can read and write files, run shell commands, JavaScript, Python and GPU code in a sandbox, browse, and open apps — all inside this tab.'),
      h('div', { class: 'ag-suggest' }, SUGGESTIONS.map((s) => h('button', { class: 'btn', onclick: () => submit(s) }, s))),
    );
    const scroller = h('div', { class: 'ag-scroll fill' }, empty, log.el);
    const input = h('textarea', { class: 'ag-input', rows: 1, placeholder: 'Ask the agent to do something…', 'aria-label': 'Message' });
    const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
    const stopBtn = h('button', { class: 'btn danger', type: 'button', hidden: true, onclick: () => agent.stop() }, 'Stop');
    const composer = h(
      'form',
      {
        class: 'ag-composer',
        onsubmit: (e: Event) => {
          e.preventDefault();
          submit(input.value);
        },
      },
      input,
      sendBtn,
      stopBtn,
    );
    const header = h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn ghost small ag-side-toggle', 'aria-label': 'Toggle sessions', onclick: () => root.classList.toggle('side-open') }, '☰'),
      modelBtn,
      h('span', { class: 'spacer' }),
      usage,
      h('button', { class: 'btn ghost small', title: 'Open the agent workspace in Files', onclick: () => ctx.launch('files', { path: '/home/agent' }) }, 'Workspace'),
    );
    root.append(h('div', { class: 'ag-root fill' }, side, h('div', { class: 'ag-main' }, header, scroller, todoSlot, composer)));

    // --- behaviour ---------------------------------------------------------
    const refreshModel = () => (modelBtn.textContent = `${describeModel(loadConfig(os))} ▾`);
    const setBusy = (busy: boolean) => {
      sendBtn.hidden = busy;
      stopBtn.hidden = !busy;
      win.setTitle(busy ? 'Agent — working…' : 'Agent');
    };
    const showTodos = () => todoSlot.replaceChildren(...[renderTodos(agent.todos)].filter((n): n is HTMLElement => n !== null));
    const refreshSessions = async () => {
      const list = await listSessions(os);
      sessions.replaceChildren(
        ...list.map((s) =>
          h(
            'div',
            { class: `ag-session ${s.id === agent.id ? 'active' : ''}` },
            h('button', { class: 'ag-session-open', title: fmtTime(s.updated), onclick: () => void openSession(s.id) }, s.title),
            h('button', { class: 'btn ghost small', 'aria-label': `Delete session ${s.title}`, onclick: () => void deleteSession(os, s.id).then(refreshSessions) }, '✕'),
          ),
        ),
      );
    };
    const persist = async () => {
      if (!agent.messages.length) return;
      await saveSession(os, { id: agent.id, title: titleFrom(agent.messages), updated: Date.now(), messages: agent.messages, todos: agent.todos }).catch((err: Error) => os.notify({ title: 'Could not save the session', body: err.message, level: 'warn' }));
      void refreshSessions();
    };

    function createAgent(id?: string): Agent {
      return new Agent(
        os,
        {
          onEvent(e) {
            log.handle(e);
            if (e.type === 'todos') showTodos();
            else if (e.type === 'usage') usage.textContent = `${fmtTokens(e.total.input + e.total.cacheRead)} in · ${fmtTokens(e.total.output)} out`;
            else if (e.type === 'error') log.addNote(e.message, 'error', /Settings/.test(e.message) ? { label: 'Open Settings', run: () => ctx.launch('settings', { section: 'model' }) } : undefined);
            else if (e.type === 'done') {
              setBusy(false);
              void persist();
              if (document.hidden && e.reason === 'end' && globalThis.Notification?.permission === 'granted') new Notification('BrowserBox agent finished', { body: titleFrom(agent.messages) });
            }
          },
          ask: (question, options) => log.ask(question, options),
        },
        { ppid: ctx.proc.pid, id },
      );
    }

    function newSession(): void {
      if (agent?.busy) return os.notify('Stop the running task first.');
      agent?.dispose();
      agent = createAgent();
      log.clear();
      empty.hidden = false;
      usage.textContent = '';
      showTodos();
      void refreshSessions();
      input.focus();
    }

    async function openSession(id: string): Promise<void> {
      if (agent.busy) return os.notify('Stop the running task first.');
      try {
        const s = await loadSession(os, id);
        agent.dispose();
        agent = createAgent(s.id);
        agent.messages = s.messages;
        agent.todos = s.todos ?? [];
        empty.hidden = true;
        log.restore(s.messages);
        showTodos();
        root.classList.remove('side-open');
        void refreshSessions();
      } catch (err) {
        os.notify({ title: 'Could not open that session', body: (err as Error).message, level: 'error' });
      }
    }

    function submit(text: string): void {
      text = text.trim();
      if (!text || agent.busy) return;
      input.value = '';
      input.style.height = '';
      empty.hidden = true;
      log.addUser(text);
      setBusy(true);
      void agent.send(text);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit(input.value);
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    });
    ctx.on('settings:change', ({ key }) => key === 'agent.config' && refreshModel());

    agent = createAgent();
    refreshModel();
    void refreshSessions();
    input.focus();
    if (typeof ctx.args.prompt === 'string') submit(ctx.args.prompt);
    return () => agent.dispose();
  },
};

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default app;
