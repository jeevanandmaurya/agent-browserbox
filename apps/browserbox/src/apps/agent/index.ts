import { agentsOf } from '@/app/agents';
import './style.css';
import './chat.css';
import './workbench.css';
import { OS_URL } from '@/app/config';
import { notifyAway, OPEN_CHAT_EVENT } from '@/app/attention';
import { profileWindow, withProfile } from '@/app/boot';
import type { AgentHandle } from '@jeevanand/agent-browserbox/ui';
import type { TodoItem } from '@jeevanand/agent-browserbox/ui';
import type { AppModule } from '@/ui/apps';
import { addMemory, GENERAL_ID, isImagePath, loadConfig, removeMemory } from '@jeevanand/agent-browserbox/ui';
import { currentProject, setCurrentProject } from '@/app/project';
import { newProjectDialog, projectSettingsDialog } from './projects';
import { openMenu } from '@/ui/menu';
import { choiceDialog, modal } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { icon } from './icons';
import { collectChanges, openChanges } from './changes';
import { createComposer, type AgentMode } from './composer';
import { attachMentions } from './mention';
import { modelLabel, modelMenuEntries } from './model-picker';
import { contextMeter } from './context-meter';
import type { SlashCommand } from './slash';
import { SettingsModal } from './settings-modal';
import { createShell } from './shell';
import { createSidebar } from './sidebar';
import { forDisplay, renderTodos, Transcript } from './view';
import { setWorkspace, TOOLS, Workbench } from './workbench';

const LAST_KEY = 'bbx-agent-last-chat';

/** The chat this window showed last in a project (per browser, not synced: a navigation convenience). */
function readLast(project: string): string | null {
  try {
    return localStorage.getItem(`${LAST_KEY}:${project}`) ?? (project === GENERAL_ID ? localStorage.getItem(LAST_KEY) : null);
  } catch {
    return null;
  }
}
function writeLast(project: string, sid: string): void {
  try {
    localStorage.setItem(`${LAST_KEY}:${project}`, sid);
  } catch {
    /* storage blocked */
  }
}

const app: AppModule = {
  async mount(ctx) {
    const { os, root, win } = ctx;
    const project = () => currentProject(os);
    const log = new Transcript();
    log.readFile = (p) => os.fs.readFile(p);
    // The session lives in the kernel; this window attaches to it and can leave without stopping it.
    let agent: AgentHandle;
    let busy = false;
    let todos: TodoItem[] = [];
    let wake: WakeLockSentinel | null = null;
    let callCount = 0;
    /** Plan mode is per window; Ask and Auto are the system's permission setting. */
    let planMode = false;
    /** The last message was sent in plan mode (offer to run the plan when it is done). */
    let lastPlan = false;
    /** Settles when a chat switch (new, open, private) has finished; messages wait for it. */
    let switching: Promise<void> = Promise.resolve();
    /** Runs a chat switch so that nothing is sent to a chat that is being left. */
    const switchTo = (fn: () => Promise<void>) => (switching = switching.then(fn, fn).catch((err: Error) => os.notify({ title: 'Could not switch chats', body: err.message, level: 'error' })));
    /** Messages written while the agent works; sent together when it finishes. */
    const queue: string[] = [];

    // --- routing: everything opens inside this window ------------------------
    // Shown inside the desktop (a window there), rather than in a tab of its own.
    const embedded = window.top !== window;
    const openTab = () => {
      if (!window.open(withProfile(location.href), profileWindow('bbx-agent'))) os.notify({ title: 'Allow pop-ups to open the agent in a new tab', level: 'warn' });
    };
    const openDesktop = () => {
      if (!open(withProfile(OS_URL), profileWindow('bbx-os'))) os.notify({ title: 'Allow pop-ups to open the desktop', level: 'warn' });
    };
    const route = (id: string, args: Record<string, unknown> = {}) => {
      if (id === 'settings') return settings.open(typeof args.section === 'string' ? args.section : undefined);
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
      { name: 'plan', description: 'Plan first: look around and propose, change nothing', kind: 'built-in', run: (args) => (setMode('plan'), args ? submit(args) : composer.focus()) },
      { name: 'changes', description: 'Review and undo what the agent changed in this chat', kind: 'built-in', run: () => showChanges() },
      { name: 'init', description: 'Write AGENTS.md: how this project is built, tested and laid out', kind: 'built-in', run: () => submit('Look at the project in your working directory and write AGENTS.md there: what it is, how to build, run and test it, how the code is laid out, and the conventions to follow. Keep it short and specific; it is read at the start of every chat.') },
      {
        name: 'remember',
        description: 'Remember a fact in this project (/remember me: … for everywhere)',
        kind: 'built-in',
        run: (args) => {
          const all = /^me:\s*/i.test(args.trim());
          const fact = args.trim().replace(/^me:\s*/i, '');
          if (!fact) return void settings.open('memory');
          void addMemory(os, all ? 'user' : 'project', project().id, fact).then(
            (m) => os.notify({ title: m, body: all ? 'About you, in every project' : `In ${project().name}`, level: 'ok' }),
            (err: Error) => os.notify({ title: 'Not remembered', body: err.message, level: 'warn' }),
          );
        },
      },
      {
        name: 'forget',
        description: 'Forget the memory entry containing this text',
        kind: 'built-in',
        run: (args) => {
          if (!args.trim()) return void settings.open('memory');
          void removeMemory(os, 'project', project().id, args)
            .catch(() => removeMemory(os, 'user', project().id, args))
            .then(
              (m) => os.notify({ title: m, level: 'ok' }),
              (err: Error) => os.notify({ title: 'Nothing forgotten', body: err.message, level: 'warn' }),
            );
        },
      },
      { name: 'memory', description: 'See and edit what the agent remembers', kind: 'built-in', run: () => settings.open('memory') },
      { name: 'schedule', description: 'Run a prompt on a schedule (/schedule <prompt>)', kind: 'built-in', run: (args) => settings.open('scheduled', args.trim() ? { prompt: args.trim() } : {}) },
      { name: 'docs', description: 'Open the documentation', kind: 'built-in', run: (args) => route('help', args ? { topic: args.trim() } : {}) },
      { name: 'help', description: 'List commands', kind: 'built-in', run: () => composer.setText('/') },
    ];
    const openModel = (anchor: HTMLElement) => openMenu(anchor, modelMenuEntries(os, () => settings.open('model'), refreshModel), 'Model');
    const getMode = (): AgentMode => (planMode ? 'plan' : os.perms.mode);
    const setMode = (m: AgentMode) => {
      planMode = m === 'plan';
      if (m !== 'plan') os.perms.mode = m;
      composer.syncMode();
    };
    const composer = createComposer(os, {
      onSubmit: submit,
      onStop: () => agent.stop(),
      openModelMenu: openModel,
      commands,
      mode: { get: getMode, set: setMode },
      cwd: () => project().folder,
      queue: {
        remove: (i) => (queue.splice(i, 1), composer.setQueue(queue)),
        // Stop now; the queue is sent as soon as the agent has stopped.
        sendNow: () => agent.stop(),
      },
    });
    const meter = contextMeter({ load: () => (agent ? agent.context() : Promise.resolve(null)), compact: () => void compactNow() });
    const sidebar = createSidebar(os, {
      newChat: () => void newSession(),
      openChat: (id) => void openSession(id),
      settings: () => settings.open(),
      profileSettings: () => settings.open('profile'),
      switchProject: (id) => void switchProject(id),
      newProject: async () => {
        const p = await newProjectDialog(os);
        if (p) await switchProject(p.id);
      },
      projectSettings: async () => {
        const r = await projectSettingsDialog(os, project());
        if (r === 'deleted') await switchProject(GENERAL_ID);
        else if (r === 'saved') await sidebar.refresh(agent.sid);
      },
      processes: () => route('taskmgr'),
      openDesktop: embedded ? openTab : openDesktop,
      embedded,
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
          { label: 'Browser', icon: 'globe', onSelect: () => route('browser') },
          { label: 'Processes', icon: 'activity', onSelect: () => route('taskmgr') },
          { separator: true },
          { label: 'Changes', icon: 'edit', hint: 'Review and undo file changes', onSelect: () => showChanges() },
          { label: 'Context', icon: 'info', hint: 'What fills the context window', onSelect: () => meter.open() },
          { label: 'Compact conversation', icon: 'refresh', onSelect: () => void compactNow() },
          { separator: true },
          { label: 'Settings', icon: 'gear', onSelect: () => settings.open() },
          { label: 'Help & docs', icon: 'question', onSelect: () => route('help') },
          embedded ? { label: 'Open in new tab', icon: 'external', onSelect: openTab } : { label: 'Open desktop', icon: 'external', onSelect: openDesktop },
        ],
        'More',
      );
    const shell = createShell({ sidebar, workbench, composer, log, actions: { more, name: () => os.settings.get<string>('user.name', ''), togglePrivate: () => void togglePrivate() } });
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
      // Keep the screen awake while the agent works.
      if (b) void navigator.wakeLock?.request('screen').then((w) => (wake = w), () => undefined);
      else void wake?.release().catch(() => undefined);
    };
    const showTodos = () => shell.todoSlot.replaceChildren(...[renderTodos(todos)].filter((n): n is HTMLElement => n !== null));

    function adopt(handle: AgentHandle): void {
      agent = handle;
      // A private chat is never reopened after a reload.
      void handle.snapshot().then((snap) => !snap.private && writeLast(snap.project, handle.sid));
      handle.onAsk((question, options) => log.ask(question, options));
      handle.prompter = (req, signal) => log.approve(req, signal);
      handle.onEvent((e) => {
        log.handle(e);
        if (e.type === 'todos') {
          todos = e.items;
          showTodos();
        } else if (e.type === 'usage') {
          meter.usage({ ...e.total, calls: (callCount += 1), tps: e.stats.tps, ttft: e.stats.ttft, model: e.model });
          meter.refresh();
        } else if (e.type === 'compact') {
          log.addNote(`${e.auto ? 'The context was nearly full, so the conversation was summarised' : 'Conversation summarised'}: about ${e.before.toLocaleString()} → ${e.after.toLocaleString()} tokens. The full history stays visible here.`);
          meter.refresh();
        }
        else if (e.type === 'error') log.addNote(e.message, 'error', /Settings/.test(e.message) ? { label: 'Open Settings', run: () => settings.open('model') } : undefined);
        else if (e.type === 'file_change') void syncChanges();
        else if (e.type === 'done') {
          setBusy(false);
          afterReply(e.reason);
          meter.refresh();
          void sidebar.refresh(agent.sid);
          void agent.snapshot().then((s) => {
            shell.setTitle(s.title);
            win.setTitle(s.title);
          });
          if (e.reason === 'end' || e.reason === 'error') {
            const sid = agent.sid;
            void agent.snapshot().then((snap) => {
              const last = [...snap.messages].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'));
              const text = last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').replace(/\s+/g, ' ').trim();
              notifyAway({ title: e.reason === 'end' ? `Done: ${snap.title || 'chat'}` : `Stopped with an error: ${snap.title || 'chat'}`, body: text, tag: `bbx-done-${sid}`, sid });
            });
          }
        }
      });
    }

    /** Shows whatever state the session is in — used when attaching to one that is already running. */
    async function showState(): Promise<void> {
      const snap = await agent.snapshot();
      const has = snap.messages.length > 0;
      // The panel's numbers belong to this chat: start from its saved totals.
      callCount = 0;
      meter.usage({ ...snap.total, calls: 0, tps: 0, ttft: 0, model: '' });
      todos = snap.todos;
      shell.setPrivate(snap.private);
      shell.setEmpty(!has);
      shell.setTitle(has ? snap.title : '');
      win.setTitle(has ? snap.title : '');
      if (has) log.restore(snap.messages, snap.diffs);
      else log.clear();
      void syncChanges();
      showTodos();
      meter.refresh();
      setBusy(snap.busy);
      void sidebar.refresh(agent.sid);
    }

    /**
     * Leaves the current session. A running one keeps working in the kernel (the sidebar
     * shows it, and opening it again rejoins it); idle ones are saved, so their process can go.
     */
    const leave = () => {
      queue.length = 0;
      composer.setQueue(queue);
      if (busy) agent.detach();
      else agent.dispose();
    };

    function newSession(): Promise<void> {
      shell.closeDrawer();
      return switchTo(async () => {
        leave();
        adopt(await agentsOf(os).create({ project: project().id }));
        await showState();
        composer.focus();
      });
    }

    /** Opens another project in this window: its chats, its folder, its last chat. */
    function switchProject(id: string): Promise<void> {
      setCurrentProject(os, id);
      setWorkspace(project().folder);
      shell.closeDrawer();
      return switchTo(async () => {
        const last = readLast(project().id);
        const next = last ? await agentsOf(os).create({ resume: last }).catch(() => null) : null;
        leave();
        adopt(next && (await next.snapshot()).project === project().id ? next : await agentsOf(os).create({ project: project().id }));
        await showState();
        await sidebar.refresh(agent.sid);
        composer.focus();
      });
    }

    /** Switches the empty chat between saved and private (a private chat with messages ends instead). */
    function togglePrivate(): Promise<void> {
      if (busy) return Promise.resolve(os.notify('A private chat starts empty: open a new chat first.'));
      return switchTo(async () => {
        const snap = await agent.snapshot();
        leave();
        adopt(await agentsOf(os).create({ private: !snap.private, project: project().id }));
        await showState();
        composer.focus();
      });
    }

    // A notification about one of your chats was clicked: show that chat.
    window.addEventListener(OPEN_CHAT_EVENT, (e) => void openSession((e as CustomEvent<string>).detail), { signal: ctx.proc.signal });

    function openSession(id: string): Promise<void> {
      if (id === agent.sid) return Promise.resolve(shell.closeDrawer());
      return switchTo(async () => {
        try {
          const next = await agentsOf(os).create({ resume: id });
          leave();
          adopt(next);
          await showState();
          shell.closeDrawer();
        } catch (err) {
          os.notify({ title: 'Could not open that chat', body: (err as Error).message, level: 'error' });
        }
      });
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
      if (!text) return false;
      // While the agent works, messages wait their turn (Send now stops it and sends them).
      if (busy) {
        queue.push(text);
        composer.setQueue(queue);
        return true;
      }
      void send(text);
      return true;
    }

    async function send(text: string): Promise<void> {
      // Never into a chat that is being left: wait for a switch in progress.
      await switching;
      const plan = planMode;
      lastPlan = plan;
      shell.setEmpty(false);
      setBusy(true);
      composer.focus();
      // @mentioned files go with the message.
      const full = await attachMentions(os, text, project().folder).catch(() => text);
      log.addUser(plan ? `${full}\n\n<mode>plan</mode>` : full);
      // Attached and @mentioned images go to the model as images too.
      const images = forDisplay(full).files.filter(isImagePath).map((p) => (p.startsWith('/') ? p : `${project().folder}/${p}`));
      void agent.send(full, { plan, ...(images.length ? { images } : {}) }).catch((err: Error) => {
        log.addNote(`Lost the agent session: ${err.message}`, 'error');
        setBusy(false);
      });
    }

    /** After a reply: offer to run a plan, then send whatever was queued. */
    function afterReply(reason: string): void {
      if (lastPlan && reason === 'end' && !queue.length) {
        log.addChoices('Go ahead with this plan?', [
          { label: 'Run the plan', primary: true, run: () => (setMode(os.perms.mode), void send('Go ahead with the plan.')) },
          { label: 'Keep planning', run: () => composer.focus() },
        ]);
      }
      lastPlan = false;
      if (queue.length) {
        const next = queue.splice(0).join('\n\n');
        composer.setQueue(queue);
        void send(next);
      }
    }

    // ---- changes and rewinding ------------------------------------------------
    const changesChip = h('button', { class: 'bb-changes', type: 'button', hidden: true, onclick: () => showChanges() });
    async function syncChanges(): Promise<void> {
      const list = await collectChanges(os, await agent.changes().catch(() => [])).catch(() => []);
      changesChip.hidden = !list.length;
      const added = list.reduce((n, c) => n + (c.diff?.added ?? 0), 0);
      const removed = list.reduce((n, c) => n + (c.diff?.removed ?? 0), 0);
      changesChip.replaceChildren(icon('edit', 14), h('span', null, `${list.length} file${list.length === 1 ? '' : 's'} changed`), h('span', { class: 'df-add' }, `+${added}`), h('span', { class: 'df-del' }, `−${removed}`), h('span', { class: 'bb-changes-go' }, 'Review'));
    }
    function showChanges(): void {
      openChanges(os, agent, { openFile: (path) => route('editor', { path }), onChanged: () => void syncChanges() });
    }
    shell.todoSlot.after(changesChip);

    // Edit an earlier message: the chat goes back to just before it (and, if you choose, so do the files).
    log.onOpenArtifact = (id, version) => route('artifacts', { id, version });

    // A sub-agent's work, read-only, in a dialog: the same view as a chat.
    log.onOpenSubagent = async (id, title) => {
      const messages = (await agent.snapshot()).subagents?.[id];
      const body = h('div', { class: 'ag-sub-log' });
      let close = () => undefined as void;
      const box = h('div', { class: 'modal ag-sub-modal', role: 'dialog', 'aria-label': `Sub-agent: ${title}` }, h('h3', null, 'Sub-agent'), h('p', { class: 'muted' }, title), body, h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')));
      if (!messages?.length) body.append(h('p', { class: 'muted' }, 'Its work is shown once it has finished.'));
      else {
        const sub = new Transcript();
        sub.readFile = (p) => os.fs.readFile(p);
        sub.restore(messages);
        body.append(sub.el);
      }
      close = modal(box, () => close());
    };

    log.onEdit = async (ordinal, text) => {
      if (busy) return os.notify('Stop the agent first (Esc), then edit.');
      const snap = await agent.snapshot();
      const userIdx = snap.messages.flatMap((m, i) => (m.role === 'user' && m.content.some((b) => b.type === 'text') ? [i] : []));
      const index = userIdx[ordinal];
      if (index === undefined) return;
      const since = new Set((await agent.changes()).filter((c) => c.turn >= index).flatMap((c) => c.files.map((f) => f.path)));
      let undo = false;
      if (since.size) {
        const choice = await choiceDialog('Edit from here?', `The chat goes back to this message. The agent changed ${since.size} file${since.size === 1 ? '' : 's'} after it: undo those changes too, or keep the files as they are now?`, [
          { id: 'keep', label: 'Keep files' },
          { id: 'undo', label: 'Undo file changes', primary: true },
        ]);
        if (!choice) return;
        undo = choice === 'undo';
      }
      try {
        const r = await agent.rewind(index, undo);
        await showState();
        composer.setText(text);
        if (r.skipped.length) os.notify({ title: `${r.skipped.length} file${r.skipped.length === 1 ? '' : 's'} could not be restored`, body: 'Binary or too large to keep: ' + r.skipped.join(', '), level: 'warn' });
      } catch (err) {
        os.notify({ title: 'Could not go back', body: (err as Error).message, level: 'error' });
      }
    };

    ctx.on('settings:change', ({ key }) => {
      if (key === 'agent.config') refreshModel();
    });
    // Sessions are saved by the kernel; refresh the list when one changes on disk.
    ctx.on('fs:change', ({ path }) => path.includes('/.sessions/') && void sidebar.refresh());

    // Rejoin a session that is already running in the kernel; failing that, reopen the chat
    // this window last showed (the kernel restarts when every window closes, e.g. on reload,
    // and phones discard background tabs); failing that, start a new one.
    setWorkspace(project().folder);
    const live = (await agentsOf(os).live()).find((l) => (l.project ?? GENERAL_ID) === project().id);
    const last = readLast(project().id);
    const fresh = () => agentsOf(os).create({ project: project().id });
    adopt(live ? await agentsOf(os).attach(live.sid) : last ? await agentsOf(os).create({ resume: last }).catch(fresh) : await fresh());
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
