import { describeSchedule, loadProjects, loadSchedules, MIN_MINUTES, nextRunAfter, SCHEDULES_KEY, type Schedule, type ScheduledTask } from '@jeevanand/agent-browserbox/ui';
import { currentProject } from '@/app/project';
import type { AppContext } from '@/ui/apps';
import { confirmDialog, modal } from '@/ui/dialog';
import { fmtTime, h } from '@/ui/dom';
import { heading } from './nav';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Scheduled tasks: prompts the agent runs on a schedule. Kept in settings,
 * which the agent cannot change: it can suggest a task, only you create one.
 */
export function scheduledSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const list = h('div', { class: 'st-sched' });
  const put = (tasks: ScheduledTask[]) => (os.settings.set(SCHEDULES_KEY, tasks), saved());

  const render = () => {
    const tasks = loadSchedules(os);
    const projects = loadProjects(os);
    list.replaceChildren(
      ...(tasks.length
        ? tasks.map((t) =>
            h(
              'div',
              { class: `st-sched-item${t.enabled ? '' : ' off'}` },
              h('div', { class: 'st-sched-head' }, h('strong', null, t.name), h('span', { class: 'badge' }, t.enabled ? describeSchedule(t.schedule) : 'Paused')),
              h('p', { class: 'muted st-note' }, `${projects.find((p) => p.id === (t.project ?? 'general'))?.name ?? 'General'} · next ${t.enabled ? fmtTime(t.nextRun) : '—'}${t.lastRun ? ` · last ${fmtTime(t.lastRun.at)}: ${t.lastRun.outcome}${t.lastRun.note ? ` — ${t.lastRun.note.slice(0, 140)}` : ''}` : ''}`),
              h(
                'div',
                { class: 'row st-wrap' },
                h('button', { class: 'btn small', type: 'button', onclick: () => put(loadSchedules(os).map((x) => (x.id === t.id ? { ...x, enabled: true, nextRun: Date.now() } : x))) }, 'Run now'),
                h('button', { class: 'btn small', type: 'button', onclick: () => put(loadSchedules(os).map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled, nextRun: nextRunAfter(x.schedule, Date.now()) } : x))) }, t.enabled ? 'Pause' : 'Resume'),
                h('button', { class: 'btn small', type: 'button', onclick: () => void edit(t) }, 'Edit'),
                h(
                  'button',
                  {
                    class: 'btn small',
                    type: 'button',
                    onclick: async () => {
                      if (await confirmDialog(`Delete “${t.name}”?`, 'Its past runs stay in your chats.', 'Delete', true)) put(loadSchedules(os).filter((x) => x.id !== t.id));
                    },
                  },
                  'Delete',
                ),
              ),
            ),
          )
        : [h('p', { class: 'muted st-note' }, 'No scheduled tasks yet.')]),
    );
  };

  /** The editor: a new task (no `task`) or an existing one. */
  function edit(task?: ScheduledTask, prompt = ''): Promise<void> {
    return new Promise((resolve) => {
      let close = () => undefined as void;
      const done = () => (close(), resolve());
      const name = h('input', { class: 'input', value: task?.name ?? '', placeholder: 'e.g. Morning summary', 'aria-label': 'Name' });
      const text = h('textarea', { class: 'textarea', rows: 5, value: task?.prompt ?? prompt, placeholder: 'What the agent should do each time', 'aria-label': 'Prompt' });
      const s = task?.schedule ?? ({ every: 'weekday', at: '08:30' } as Schedule);
      const every = h('select', { class: 'select', 'aria-label': 'Repeat' }, [
        h('option', { value: 'minutes' }, 'Every few minutes'),
        h('option', { value: 'hour' }, 'Every hour'),
        h('option', { value: 'day' }, 'Every day'),
        h('option', { value: 'weekday' }, 'Weekdays'),
        h('option', { value: 'week' }, 'Every week'),
      ]);
      every.value = s.every;
      const time = h('input', { class: 'input', type: 'time', value: 'at' in s ? s.at : '08:30', 'aria-label': 'At' });
      const day = h('select', { class: 'select', 'aria-label': 'Day' }, DAYS.map((d, i) => h('option', { value: String(i) }, d)));
      day.value = String('day' in s ? s.day : 1);
      const minutes = h('input', { class: 'input st-num', type: 'number', min: MIN_MINUTES, step: 5, value: String('minutes' in s ? s.minutes : 60), 'aria-label': 'Minutes' });
      const minute = h('input', { class: 'input st-num', type: 'number', min: 0, max: 59, value: String('minute' in s ? (s.minute ?? 0) : 0), 'aria-label': 'Minute past the hour' });
      const sync = () => {
        const v = every.value;
        time.hidden = !['day', 'weekday', 'week'].includes(v);
        day.hidden = v !== 'week';
        minutes.hidden = v !== 'minutes';
        minute.hidden = v !== 'hour';
      };
      every.addEventListener('change', sync);
      sync();
      const project = h('select', { class: 'select', 'aria-label': 'Project' }, loadProjects(os).map((p) => h('option', { value: p.id }, p.name)));
      project.value = task?.project ?? currentProject(os).id;
      const allow = { edits: task?.allow.edits ?? true, commands: task?.allow.commands ?? false, network: task?.allow.network ?? false };
      const check = (key: keyof typeof allow, label: string) => {
        const box = h('input', { type: 'checkbox', checked: allow[key], onchange: () => (allow[key] = box.checked) });
        return h('label', { class: 'st-check' }, box, label);
      };
      const missed = h('select', { class: 'select', 'aria-label': 'Missed runs' }, h('option', { value: 'run' }, 'Run when BrowserBox opens'), h('option', { value: 'skip' }, 'Skip it'));
      missed.value = task?.missed ?? 'run';
      const notify = h('input', { type: 'checkbox', checked: task?.notify ?? true });
      const error = h('p', { class: 'st-error', role: 'alert', hidden: true });
      const save = () => {
        const v = every.value as Schedule['every'];
        const schedule: Schedule =
          v === 'minutes' ? { every: 'minutes', minutes: Math.max(MIN_MINUTES, Number(minutes.value) || 60) } : v === 'hour' ? { every: 'hour', minute: Math.min(59, Math.max(0, Number(minute.value) || 0)) } : v === 'week' ? { every: 'week', day: Number(day.value), at: time.value || '08:30' } : { every: v, at: time.value || '08:30' };
        if (!name.value.trim() || !text.value.trim()) {
          error.textContent = 'Give it a name and a prompt.';
          error.hidden = false;
          return;
        }
        const next: ScheduledTask = {
          id: task?.id ?? crypto.randomUUID(),
          name: name.value.trim().slice(0, 80),
          prompt: text.value.trim(),
          schedule,
          project: project.value,
          allow: { ...allow },
          missed: missed.value as 'run' | 'skip',
          notify: notify.checked,
          enabled: task?.enabled ?? true,
          nextRun: nextRunAfter(schedule, Date.now()),
          ...(task?.lastRun ? { lastRun: task.lastRun } : {}),
        };
        put(task ? loadSchedules(os).map((x) => (x.id === task.id ? next : x)) : [...loadSchedules(os), next]);
        done();
      };
      const row = (label: string, ...controls: HTMLElement[]) => h('div', { class: 'pj-field' }, h('span', null, label), h('div', { class: 'row st-wrap' }, ...controls));
      const box = h(
        'div',
        { class: 'modal pj-modal', role: 'dialog', 'aria-label': task ? 'Edit scheduled task' : 'New scheduled task' },
        h('h3', null, task ? 'Edit scheduled task' : 'New scheduled task'),
        row('Name', name),
        row('Prompt', text),
        row('When', every, time, day, minutes, minute),
        row('Project', project),
        h('div', { class: 'pj-field' }, h('span', null, 'Nobody is there to approve, so it may only:'), check('edits', 'Change files'), check('commands', 'Run commands and code'), check('network', 'Use the network')),
        row('If BrowserBox was closed at the time', missed),
        h('label', { class: 'st-check' }, notify, 'Notify me when it finishes'),
        error,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: done }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: save }, task ? 'Save' : 'Create')),
      );
      close = modal(box, done);
      name.focus();
    });
  }

  render();
  ctx.on('settings:change', ({ key }) => key === SCHEDULES_KEY && render());
  if (typeof ctx.args.prompt === 'string') queueMicrotask(() => void edit(undefined, ctx.args.prompt as string));

  return h(
    'div',
    { class: 'st-section' },
    heading('Scheduled', 'Prompts the agent runs on a schedule, each as a chat in its project.'),
    h(
      'p',
      { class: 'st-callout muted' },
      'Tasks run only while BrowserBox is open in some window or tab: a browser cannot wake a closed web page. When it was closed at the time, a task runs as soon as BrowserBox opens again, or skips that run, as you choose. For frequent tasks, install BrowserBox as an app and keep a window open.',
    ),
    list,
    h('button', { class: 'btn', type: 'button', onclick: () => void edit() }, 'New scheduled task'),
  );
}
