import './style.css';
import { describeModel, loadConfig } from '@/agent/config';
import { deleteSession, listSessions } from '@/agent/session';
import type { AgentHandle } from '@/kernel/api';
import type { AppModule } from '@/ui/apps';
import { fmtTime, h } from '@/ui/dom';
import type { TodoItem } from '@/agent/tools/types';
import { renderTodos, Transcript } from './view';

const SUGGESTIONS = [
  'Give me a tour: what can you do in this OS?',
  'Build a small interactive web page and show it to me',
  'Write a Python script that plots a sine wave, run it, and show the chart',
  'Benchmark a WebGPU compute shader against plain JavaScript',
];

const app: AppModule = {
  async mount(ctx) {
    const { os, root, win } = ctx;
    const log = new Transcript();
    // The session lives in the kernel; this window attaches to it and can leave without stopping it.
    let agent: AgentHandle;
    let busy = false;
    let hasMessages = false;
    let todos: TodoItem[] = [];
    let wake: WakeLockSentinel | null = null;

    // --- layout ------------------------------------------------------------
    const modelBtn = h('button', { class: 'btn small ag-model', title: 'Change model', onclick: () => ctx.launch('settings', { section: 'model' }) });
    const usage = h('span', { class: 'muted ag-usage' });
    const sessions = h('div', { class: 'ag-sessions' });
    const side = h('aside', { class: 'ag-side' }, h('button', { class: 'btn primary', onclick: () => void newSession() }, '+ New session'), sessions);
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
    const setBusy = (b: boolean) => {
      busy = b;
      sendBtn.hidden = b;
      stopBtn.hidden = !b;
      win.setTitle(b ? 'Agent — working…' : 'Agent');
      // Keep the screen awake while the agent works.
      if (b) void navigator.wakeLock?.request('screen').then((w) => (wake = w), () => undefined);
      else void wake?.release().catch(() => undefined);
    };
    const showTodos = () => todoSlot.replaceChildren(...[renderTodos(todos)].filter((n): n is HTMLElement => n !== null));
    const refreshSessions = async () => {
      const list = await listSessions(os);
      sessions.replaceChildren(
        ...list.map((s) =>
          h(
            'div',
            { class: `ag-session ${s.id === agent.sid ? 'active' : ''}` },
            h('button', { class: 'ag-session-open', title: fmtTime(s.updated), onclick: () => void openSession(s.id) }, s.title),
            h('button', { class: 'btn ghost small', 'aria-label': `Delete session ${s.title}`, onclick: () => void deleteSession(os, s.id).then(refreshSessions) }, '✕'),
          ),
        ),
      );
    };
    function adopt(handle: AgentHandle): void {
      agent = handle;
      handle.onAsk((question, options) => log.ask(question, options));
      handle.onEvent((e) => {
        log.handle(e);
        if (e.type === 'todos') {
          todos = e.items;
          showTodos();
        } else if (e.type === 'usage') usage.textContent = `${fmtTokens(e.total.input + e.total.cacheRead)} in · ${fmtTokens(e.total.output)} out`;
        else if (e.type === 'error') log.addNote(e.message, 'error', /Settings/.test(e.message) ? { label: 'Open Settings', run: () => ctx.launch('settings', { section: 'model' }) } : undefined);
        else if (e.type === 'done') {
          setBusy(false);
          if (document.hidden && e.reason === 'end' && globalThis.Notification?.permission === 'granted') new Notification('BrowserBox agent finished');
        }
      });
    }

    /** Shows whatever state the session is in — used when attaching to one that is already running. */
    async function showState(): Promise<void> {
      const snap = await agent.snapshot();
      hasMessages = snap.messages.length > 0;
      todos = snap.todos;
      empty.hidden = hasMessages;
      if (hasMessages) log.restore(snap.messages);
      else log.clear();
      usage.textContent = snap.total.output ? `${fmtTokens(snap.total.input + snap.total.cacheRead)} in · ${fmtTokens(snap.total.output)} out` : '';
      showTodos();
      setBusy(snap.busy);
      void refreshSessions();
    }

    /** Leaves the current session: idle ones are already saved, so their process can go. */
    const leave = () => agent.dispose();

    async function newSession(): Promise<void> {
      if (busy) return os.notify('Stop the running task first.');
      leave();
      adopt(await os.agents.create());
      await showState();
      input.focus();
    }

    async function openSession(id: string): Promise<void> {
      if (busy) return os.notify('Stop the running task first.');
      try {
        const next = await os.agents.create({ resume: id });
        leave();
        adopt(next);
        await showState();
        root.classList.remove('side-open');
      } catch (err) {
        os.notify({ title: 'Could not open that session', body: (err as Error).message, level: 'error' });
      }
    }

    function submit(text: string): void {
      text = text.trim();
      if (!text || busy) return;
      input.value = '';
      input.style.height = '';
      empty.hidden = true;
      hasMessages = true;
      log.addUser(text);
      setBusy(true);
      void agent.send(text).catch((err: Error) => {
        log.addNote(`Lost the agent session: ${err.message}`, 'error');
        setBusy(false);
      });
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

    // Sessions are saved by the kernel; refresh the list when one changes on disk.
    ctx.on('fs:change', ({ path }) => path.includes('/.sessions/') && void refreshSessions());

    refreshModel();
    // Rejoin a session that is already running in the kernel, otherwise start one.
    const [live] = await os.agents.live();
    adopt(live ? await os.agents.attach(live.sid) : await os.agents.create());
    await showState();
    input.focus();
    if (typeof ctx.args.prompt === 'string') submit(ctx.args.prompt);
    return () => agent.detach();
  },
};

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default app;
