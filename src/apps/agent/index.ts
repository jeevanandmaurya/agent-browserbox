import './style.css';
import './chat.css';
import './workbench.css';
import { OS_URL } from '@/config/origins';
import type { AgentHandle } from '@/kernel/api';
import type { TodoItem } from '@/agent/tools/types';
import type { AppModule } from '@/ui/apps';
import { createComposer } from './composer';
import { SettingsModal } from './settings-modal';
import { createShell } from './shell';
import { createSidebar } from './sidebar';
import { renderTodos, Transcript } from './view';
import { TOOLS, Workbench } from './workbench';

const SETUP_KEY = 'setup.done';

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
    const composer = createComposer(os, { onSubmit: submit, onStop: () => agent.stop(), openModelSettings: () => settings.open('model') });
    const sidebar = createSidebar(os, {
      newChat: () => void newSession(),
      openChat: (id) => void openSession(id),
      settings: () => settings.open('model'),
      processes: () => route('taskmgr'),
      openDesktop,
      collapse: () => sidebar.el.dispatchEvent(new Event('bb-collapse')),
    });
    const shell = createShell({ sidebar, workbench, composer, log, suggest: (p) => submit(p) });
    root.append(shell.el);
    shell.setEmpty(true);
    // The kernel (or the agent's open_app / show_html tools) asked for an app.
    // Requests raised by other windows (the desktop launching its own apps) are theirs to handle.
    ctx.on('app:open', ({ id, args, fromWindow }) => !fromWindow && route(id, args ?? {}));

    // --- behaviour ---------------------------------------------------------
    const setBusy = (b: boolean) => {
      busy = b;
      composer.setBusy(b);
      win.setTitle(b ? 'BrowserBox — working…' : 'BrowserBox');
      // Keep the screen awake while the agent works.
      if (b) void navigator.wakeLock?.request('screen').then((w) => (wake = w), () => undefined);
      else void wake?.release().catch(() => undefined);
    };
    const showTodos = () => shell.todoSlot.replaceChildren(...[renderTodos(todos)].filter((n): n is HTMLElement => n !== null));
    const showUsage = (input: number, output: number) => (shell.usage.textContent = output ? `${fmtTokens(input)} in · ${fmtTokens(output)} out` : '');

    function adopt(handle: AgentHandle): void {
      agent = handle;
      handle.onAsk((question, options) => log.ask(question, options));
      handle.prompter = (req, signal) => log.approve(req, signal);
      handle.onEvent((e) => {
        log.handle(e);
        if (e.type === 'todos') {
          todos = e.items;
          showTodos();
        } else if (e.type === 'usage') showUsage(e.total.input + e.total.cacheRead, e.total.output);
        else if (e.type === 'error') log.addNote(e.message, 'error', /Settings/.test(e.message) ? { label: 'Open Settings', run: () => settings.open('model') } : undefined);
        else if (e.type === 'done') {
          setBusy(false);
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
      showUsage(snap.total.input + snap.total.cacheRead, snap.total.output);
      showTodos();
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

    /** Shows the first-run setup in place of the chat until it is finished or skipped. */
    const runSetup = async () => {
      // Only first-time visitors pay for the setup code.
      const { createSetup } = await import('./setup');
      return new Promise<void>((resolve) => {
        settings.close();
        shell.el.hidden = true;
        const setup = createSetup(os, () => {
          shell.el.hidden = false;
          composer.focus();
          resolve();
        });
        root.append(setup.el);
      });
    };

    ctx.on('settings:change', ({ key, value }) => {
      if (key === 'agent.config') composer.refreshModel();
      if (key === 'setup.done' && value === false && !root.querySelector('.su')) void runSetup();
    });
    // Sessions are saved by the kernel; refresh the list when one changes on disk.
    ctx.on('fs:change', ({ path }) => path.includes('/.sessions/') && void sidebar.refresh());

    if (!os.settings.get(SETUP_KEY, false)) await runSetup();
    // Rejoin a session that is already running in the kernel, otherwise start one.
    const [live] = await os.agents.live();
    adopt(live ? await os.agents.attach(live.sid) : await os.agents.create());
    await showState();
    composer.focus();
    if (typeof ctx.args.prompt === 'string') submit(ctx.args.prompt);
    return () => {
      agent.detach();
      settings.close();
    };
  },
};

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default app;
