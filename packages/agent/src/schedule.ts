import type { AgentManager } from './manager.js';
import type { AgentEvent } from './agent.js';
import type { Capability, PermRequest } from './host/perms.js';
import type { WithSettings } from './host/os.js';

/**
 * Scheduled tasks: a prompt the agent runs on a schedule, in a project, as a
 * normal chat (so results are in the chat list).
 *
 * A browser cannot wake a closed web app, so tasks run only while BrowserBox
 * is open (any window of the profile). When it was closed at the time, each
 * task either runs as soon as BrowserBox opens again, or skips the missed run.
 *
 * Kept in the setting `agent.schedules`, which no tool writes: the agent can
 * suggest a task, but only the user creates one.
 */
export type Schedule =
  | { every: 'hour'; minute?: number }
  | { every: 'day'; at: string }
  | { every: 'weekday'; at: string }
  | { every: 'week'; day: number; at: string }
  | { every: 'minutes'; minutes: number };

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  /** The project it runs in (default General). */
  project?: string;
  /** What an unattended run may do; anything else is refused (nobody is there to ask). */
  allow: { edits: boolean; commands: boolean; network: boolean };
  /** BrowserBox was closed at the time: run when it opens, or skip. */
  missed: 'run' | 'skip';
  notify: boolean;
  enabled: boolean;
  nextRun: number;
  lastRun?: { at: number; session?: string; outcome: 'ok' | 'error' | 'skipped'; note: string };
}

export const SCHEDULES_KEY = 'agent.schedules';
/** The shortest repeat allowed. */
export const MIN_MINUTES = 15;
/** How late a run may start before it counts as missed. */
const LATE = 2 * 60_000;
/** A run is stopped after this long. */
const MAX_RUN_MS = 30 * 60_000;
/** Runs at the same time, across tasks. */
const MAX_RUNNING = 2;

const hm = (at: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  const h = m ? Math.min(23, Number(m[1])) : 9;
  const min = m ? Math.min(59, Number(m[2])) : 0;
  return [h, min];
};

/** When a schedule next fires after `from` (local time, so daylight-saving changes keep the clock time). */
export function nextRunAfter(s: Schedule, from: number): number {
  const d = new Date(from);
  if (s.every === 'minutes') return from + Math.max(MIN_MINUTES, Math.round(s.minutes)) * 60_000;
  if (s.every === 'hour') {
    const next = new Date(d);
    next.setMinutes(Math.min(59, Math.max(0, s.minute ?? 0)), 0, 0);
    if (next.getTime() <= from) next.setHours(next.getHours() + 1);
    return next.getTime();
  }
  const [h, min] = hm(s.at);
  const next = new Date(d);
  next.setHours(h, min, 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  const day = 'day' in s ? s.day : -1;
  const ok = (x: Date) => (s.every === 'weekday' ? x.getDay() >= 1 && x.getDay() <= 5 : s.every === 'week' ? x.getDay() === day : true);
  for (let i = 0; i < 8 && !ok(next); i++) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** In words, for lists: "Weekdays at 08:30". */
export function describeSchedule(s: Schedule): string {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (s.every === 'minutes') return `Every ${s.minutes} minutes`;
  if (s.every === 'hour') return `Every hour at :${String(s.minute ?? 0).padStart(2, '0')}`;
  if (s.every === 'day' || s.every === 'weekday') return s.every === 'day' ? `Every day at ${s.at}` : `Weekdays at ${s.at}`;
  return `Every ${DAYS[s.day] ?? 'week'} at ${s.at}`;
}

export function loadSchedules(os: WithSettings): ScheduledTask[] {
  const list = os.settings.get<unknown>(SCHEDULES_KEY, []);
  return Array.isArray(list) ? list.filter((t): t is ScheduledTask => !!t && typeof t.id === 'string' && typeof t.prompt === 'string' && !!t.schedule) : [];
}

function patchSchedule(os: WithSettings, id: string, patch: Partial<ScheduledTask>): void {
  // Read fresh: the user may have edited the list while a run went on.
  os.settings.set(
    SCHEDULES_KEY,
    loadSchedules(os).map((t) => (t.id === id ? { ...t, ...patch } : t)),
  );
}

/** What an unattended run may do, from the task's allowances. */
function allowedFor(task: ScheduledTask, cap: Capability): boolean {
  if (cap === 'fs.write') return task.allow.edits;
  if (cap === 'exec') return task.allow.commands;
  if (cap === 'net') return task.allow.network;
  return cap === 'notify';
}

export interface SchedulerHost {
  /** Tells the user a run finished (a notification). */
  notify?(n: { title: string; body: string; session?: string; error?: boolean }): void;
  /** Exclusive run of one task across workers (Web Locks); runs `fn` only when nobody else is. */
  exclusive?(name: string, fn: () => Promise<void>): Promise<void>;
}

/**
 * Runs due tasks. Call `start()` once; it checks every 15 seconds. A task set
 * to run now (`nextRun` in the past, as "Run now" does) starts at the next check.
 */
export class Scheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = new Set<string>();

  constructor(
    private os: WithSettings,
    private agents: AgentManager,
    private host: SchedulerHost = {},
  ) {}

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Starts every task that is due (exposed for tests and "Run now"). Resolves when they finished. */
  async tick(now = Date.now()): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const task of loadSchedules(this.os)) {
      if (!task.enabled || task.nextRun > now || this.#running.has(task.id)) continue;
      const late = now - task.nextRun > LATE && task.lastRun?.outcome !== undefined;
      const next = nextRunAfter(task.schedule, now);
      if (late && task.missed === 'skip') {
        patchSchedule(this.os, task.id, { nextRun: next, lastRun: { at: now, outcome: 'skipped', note: `Skipped the run of ${new Date(task.nextRun).toLocaleString()}: BrowserBox was closed.` } });
        continue;
      }
      if (this.#running.size >= MAX_RUNNING) break;
      this.#running.add(task.id);
      patchSchedule(this.os, task.id, { nextRun: next });
      const run = () => this.#run(task);
      runs.push((this.host.exclusive ? this.host.exclusive(`bbx-schedule-${task.id}`, run) : run()).finally(() => this.#running.delete(task.id)));
    }
    await Promise.all(runs);
  }

  async #run(task: ScheduledTask): Promise<void> {
    const started = Date.now();
    const stamp = new Date(started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    let session: string | undefined;
    try {
      const chat = await this.agents.create({ project: task.project });
      session = chat.sid;
      // Nobody is there to answer: permissions come from the task, questions get a fixed answer.
      chat.prompter = async (req: PermRequest) => (allowedFor(task, req.cap) ? 'once' : 'deny');
      chat.onAsk(async () => 'This is a scheduled run and nobody can answer now. Use your best judgement, and say in your report what you assumed.');
      const done = new Promise<AgentEvent & { type: 'done' }>((resolve) => {
        const off = chat.onEvent((e) => e.type === 'done' && (off(), resolve(e)));
      });
      const timer = setTimeout(() => chat.stop(), MAX_RUN_MS);
      void chat.send(`⏱ ${task.name} · ${stamp}\n\n${task.prompt}\n\n(This is a scheduled run: nobody is watching. Permissions you lack are refused; do what you can and finish with a short report.)`);
      const end = await done;
      clearTimeout(timer);
      const snap = await chat.snapshot();
      const last = [...snap.messages].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'));
      const report = last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim() ?? '';
      const ok = end.reason === 'end';
      const note = ok ? report.slice(0, 300) || 'Done.' : end.reason === 'stopped' ? 'Stopped after 30 minutes.' : end.reason === 'max_steps' ? 'Stopped at the step limit.' : 'Failed: see the chat.';
      patchSchedule(this.os, task.id, { lastRun: { at: started, session, outcome: ok ? 'ok' : 'error', note } });
      if (task.notify) this.host.notify?.({ title: `${task.name}: ${ok ? 'done' : 'did not finish'}`, body: note.slice(0, 200), session, error: !ok });
      chat.detach();
    } catch (err) {
      const note = (err as Error).message ?? String(err);
      patchSchedule(this.os, task.id, { lastRun: { at: started, session, outcome: 'error', note } });
      if (task.notify) this.host.notify?.({ title: `${task.name}: could not run`, body: note.slice(0, 200), session, error: true });
    }
  }
}
