import './style.css';
import './chat.css';
import './workbench.css';
import { OS_URL } from '@/config/origins';
import type { AgentHandle } from '@/kernel/api';
import type { TodoItem } from '@/agent/tools/types';
import type { AppModule } from '@/ui/apps';
import { loadConfig } from '@/agent/config';
import { openMenu } from '@/ui/menu';
import { createComposer } from './composer';
import { modelLabel, modelMenuEntries } from './model-picker';
import { contextMeter } from './context-meter';
import type { SlashCommand } from './slash';
import { SettingsModal } from './settings-modal';
import { createShell } from './shell';
import { createSidebar } from './sidebar';
import { renderTodos, Transcript } from './view';
import { TOOLS, Workbench } from './workbench';

const LAST_KEY = 'bbx-agent-last-chat';

/** The chat this window showed last (per browser, not synced: it is a navigation convenience). */
function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
function writeLast(sid: string): void {
  try {
    localStorage.setItem(LAST_KEY, sid);
  } catch {
    /* storage blocked */
  }
}

const app: AppModule = {
  async mount(ctx) {
    const { os, root, win } = ctx;
    const log = new Transcript();
    // The session lives in the kernel; this window attaches to it and can leave without stopping it.
    let agent: AgentHandle;
    let busy = false;
    let todos: TodoItem[] = [];
    let wake: WakeLockSentinel | null = null;

    // --- routing: everything opens inside this window ------------------------
    const openDesktop = () => {
      if (!open(OS_URL, 'bbx-os')) os.notify({ title: 'Allow pop-ups to open the desktop', level: 'warn' });
    };
    const route = (id: string, args: Record<string, unknown> = {}) => {
      if (id === 'settings') return settings.open(typeof args.section === 'string' ? args.section : 'model');
      if (id === 'agent') return composer.focus();
      if (TOOLS.some((t) => t.id === id)) {
        workbench.open(id, args);
        shell.closeDrawer();
        return;
      }
      os.notify({ title: `${id} is only available on the desktop`, body: 'Use “Open desktop” in the sidebar.', level: 'warn' });
    };
    const settings = new SettingsModal(os, route);
    const workbench = new Workbench(os, { onChange: () => shell.syncWorkbench(), route });
    const commands: SlashCommand[] = [
      { name: 'compact', description: 'Summarise the conversation to free up context', kind: 'built-in', run: () => void compactNow() },
      { name: 'context', description: 'Show how full the context window is', kind: 'built-in', run: () => meter.open() },
      { name: 'clear', description: 'Start a new chat', kind: 'built-in', run: () => void newSession() },
      { name: 'skills', description: 'Manage skills', kind: 'built-in', run: () => settings.open('skills') },
      { name: 'agents', description: 'Manage custom agents', kind: 'built-in', run: () => settings.open('agents') },
      { name: 'connectors', description: 'Manage MCP connectors', kind: 'built-in', run: () => settings.open('connectors') },
      { name: 'model', description: 'Model settings', kind: 'built-in', run: () => settings.open('model') },
      { name: 'help', description: 'List commands', kind: 'built-in', run: () => composer.setText('/') },
    ];
    const openModel = (anchor: HTMLElement) => openMenu(anchor, modelMenuEntries(os, () => settings.open('model'), refreshModel), 'Model');
    const composer = createComposer(os, { onSubmit: submit, onStop: () => agent.stop(), openModelMenu: openModel, commands });
    const meter = contextMeter({ load: () => (agent ? agent.context() : Promise.resolve(null)), compact: () => void compactNow() });
    const sidebar = createSidebar(os, {
      newChat: () => void newSession(),
      openChat: (id) => void openSession(id),
      settings: () => settings.open('model'),
      processes: () => route('taskmgr'),
      openDesktop,
      collapse: () => sidebar.el.dispatchEvent(new Event('bb-collapse')),
    });
    const more = (anchor: HTMLElement) =>
      openMenu(
        anchor,
        [
          { label: 'New chat', icon: 'newChat', onSelect: () => void newSession() },
          { separator: true },
          { label: 'Files', icon: 'folder', onSelect: () => route('files') },
          { label: 'Terminal', icon: 'terminal', onSelect: () => route('terminal') },
          { label: 'Preview', icon: 'eye', onSelect: () => route('preview') },
          { label: 'Processes', icon: 'activity', onSelect: () => route('taskmgr') },
          { separator: true },
          { label: 'Context', icon: 'info', hint: 'What fills the context window', onSelect: () => meter.open() },
          { label: 'Compact conversation', icon: 'refresh', onSelect: () => void compactNow() },
          { separator: true },
          { label: 'Settings', icon: 'gear', onSelect: () => settings.open('model') },
          { label: 'Open desktop', icon: 'external', onSelect: openDesktop },
        ],
        'More',
      );
    const shell = createShell({ sidebar, workbench, composer, log, actions: { more, model: openModel, name: () => os.settings.get<string>('user.name', '') } });
    const refreshModel = () => shell.setSubtitle(modelLabel(loadConfig(os)));
    shell.meterSlot.append(meter.el);
    refreshModel();
    root.append(shell.el);
    shell.setEmpty(true);
    // The kernel (or the agent's open_app / show_html tools) asked for an app.
    // Requests raised by other windows (the desktop launching its own apps) are theirs to handle.
    ctx.on('app:open', ({ id, args, fromWindow }) => !fromWindow && route(id, args ?? {}));

    // --- behaviour ---------------------------------------------------------
    const setBusy = (b: boolean) => {
      busy = b;
      composer.setBusy(b);
      shell.setBusy(b);
      win.setTitle(b ? 'BrowserBox — working…' : 'BrowserBox');
      // Keep the screen awake while the agent works.
      if (b) void navigator.wakeLock?.request('screen').then((w) => (wake = w), () => undefined);
      else void wake?.release().catch(() => undefined);
    };
    const showTodos = () => shell.todoSlot.replaceChildren(...[renderTodos(todos)].filter((n): n is HTMLElement => n !== null));

    function adopt(handle: AgentHandle): void {
      agent = handle;
      writeLast(handle.sid);
      handle.onAsk((question, options) => log.ask(question, options));
      handle.prompter = (req, signal) => log.approve(req, signal);
      handle.onEvent((e) => {
        log.handle(e);
        if (e.type === 'todos') {
          todos = e.items;
          showTodos();
        } else if (e.type === 'usage') {
          meter.refresh();
        } else if (e.type === 'compact') {
          log.addNote(`${e.auto ? 'The context was nearly full, so the conversation was summarised' : 'Conversation summarised'}: about ${e.before.toLocaleString()} → ${e.after.toLocaleString()} tokens. The full history stays visible here.`);
          meter.refresh();
        }
        else if (e.type === 'error') log.addNote(e.message, 'error', /Settings/.test(e.message) ? { label: 'Open Settings', run: () => settings.open('model') } : undefined);
        else if (e.type === 'done') {
          setBusy(false);
          meter.refresh();
          void sidebar.refresh(agent.sid);
          void agent.snapshot().then((s) => shell.setTitle(s.title));
          if (document.hidden && e.reason === 'end' && globalThis.Notification?.permission === 'granted') new Notification('BrowserBox agent finished');
        }
      });
    }

    /** Shows whatever state the session is in — used when attaching to one that is already running. */
    async function showState(): Promise<void> {
      const snap = await agent.snapshot();
      const has = snap.messages.length > 0;
      todos = snap.todos;
      shell.setEmpty(!has);
      shell.setTitle(has ? snap.title : '');
      if (has) log.restore(snap.messages);
      else log.clear();
      showTodos();
      meter.refresh();
      setBusy(snap.busy);
      void sidebar.refresh(agent.sid);
    }

    /** Leaves the current session: idle ones are already saved, so their process can go. */
    const leave = () => agent.dispose();

    async function newSession(): Promise<void> {
      shell.closeDrawer();
      if (busy) return os.notify('Stop the running task first.');
      leave();
      adopt(await os.agents.create());
      await showState();
      composer.focus();
    }

    async function openSession(id: string): Promise<void> {
      if (busy) return os.notify('Stop the running task first.');
      if (id === agent.sid) return shell.closeDrawer();
      try {
        const next = await os.agents.create({ resume: id });
        leave();
        adopt(next);
        await showState();
        shell.closeDrawer();
      } catch (err) {
        os.notify({ title: 'Could not open that chat', body: (err as Error).message, level: 'error' });
      }
    }

    async function compactNow(): Promise<void> {
      if (busy) return os.notify('Wait for the agent to finish first.');
      setBusy(true);
      try {
        await agent.compact();
      } catch (err) {
        log.addNote(`Could not compact: ${(err as Error).message}`, 'error');
        setBusy(false);
      }
    }

    function submit(text: string): boolean {
      text = text.trim();
      if (!text || busy) return false;
      shell.setEmpty(false);
      log.addUser(text);
      setBusy(true);
      composer.focus();
      void agent.send(text).catch((err: Error) => {
        log.addNote(`Lost the agent session: ${err.message}`, 'error');
        setBusy(false);
      });
      return true;
    }

    ctx.on('settings:change', ({ key }) => {
      if (key === 'agent.config') refreshModel();
    });
    // Sessions are saved by the kernel; refresh the list when one changes on disk.
    ctx.on('fs:change', ({ path }) => path.includes('/.sessions/') && void sidebar.refresh());

    // Rejoin a session that is already running in the kernel; failing that, reopen the chat
    // this window last showed (the kernel restarts when every window closes, e.g. on reload,
    // and phones discard background tabs); failing that, start a new one.
    const [live] = await os.agents.live();
    const last = readLast();
    adopt(live ? await os.agents.attach(live.sid) : last ? await os.agents.create({ resume: last }).catch(() => os.agents.create()) : await os.agents.create());
    await showState();
    composer.focus();
    if (typeof ctx.args.prompt === 'string') submit(ctx.args.prompt);
    return () => {
      agent.detach();
      settings.close();
    };
  },
};


export default app;
