import type { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { plainText } from './host/ansi.js';

/** A command the agent started in the background: it runs while the agent does other things. */
export interface Job {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  started: number;
  /** Exit code once it has finished (124: timed out, 130: stopped). */
  code: number | null;
  ended: number | null;
}

interface Running extends Job {
  /** The output kept (the newest part, when there is a lot). */
  text: string;
  /** Characters dropped from the start of `text` to keep it small. */
  dropped: number;
  /** How far the agent has read, counted from the very start of the output. */
  read: number;
  /** Its end has been told to the agent. */
  told: boolean;
  kill(): Promise<boolean>;
  /** Resolves when there is new output or it ends. */
  changed: Promise<void>;
  wake(): void;
}

/** Output kept per job. */
const KEEP = 200_000;

/**
 * A chat's background jobs. They keep running between the agent's turns
 * (it is told when one ends) and stop when the chat ends.
 */
export class Jobs {
  #jobs = new Map<string, Running>();
  #n = 0;

  constructor(private box: () => BrowserBox) {}

  async start(command: string, cwd: string, env: Record<string, string>): Promise<Job> {
    const p = await this.box().spawn(command, { cwd, env });
    let wake = () => undefined as void;
    const job: Running = {
      id: `job${++this.#n}`,
      command,
      cwd,
      pid: p.pid,
      started: Date.now(),
      code: null,
      ended: null,
      text: '',
      dropped: 0,
      read: 0,
      told: false,
      kill: () => p.kill(),
      changed: new Promise((r) => (wake = r)),
      wake: () => undefined,
    };
    job.wake = () => {
      wake();
      job.changed = new Promise((r) => (wake = r));
    };
    this.#jobs.set(job.id, job);
    void (async () => {
      const reader = p.output.getReader();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        job.text += value;
        if (job.text.length > KEEP) {
          const cut = job.text.length - KEEP;
          job.text = job.text.slice(cut);
          job.dropped += cut;
        }
        job.wake();
      }
    })();
    void p.exit.then((code) => {
      job.code = code;
      job.ended = Date.now();
      job.wake();
    });
    return job;
  }

  list(): Job[] {
    return [...this.#jobs.values()];
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  /**
   * The output the agent has not read yet; with `waitMs`, waits up to that long
   * for some (or for the job to end) when there is none.
   */
  async output(id: string, opts: { waitMs?: number; all?: boolean } = {}): Promise<{ job: Job; text: string; skipped: number }> {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`no background job ${id} (see action "list")`);
    const unread = () => job.dropped + job.text.length > job.read;
    if (opts.waitMs && job.code === null && !unread()) {
      await Promise.race([job.changed, new Promise((r) => setTimeout(r, Math.min(opts.waitMs!, 120_000)))]);
      // Output comes in bursts, and a command's end just after its last line: let it settle.
      for (let i = 0; i < 4 && job.code === null; i++) {
        const before = job.dropped + job.text.length;
        await Promise.race([job.changed, new Promise((r) => setTimeout(r, 250))]);
        if (job.code === null && job.dropped + job.text.length === before) break;
      }
    }
    const from = opts.all ? job.dropped : Math.max(job.read, job.dropped);
    const skipped = opts.all ? job.dropped : Math.max(0, job.dropped - job.read);
    const text = plainText(job.text.slice(from - job.dropped));
    job.read = job.dropped + job.text.length;
    if (job.code !== null) job.told = true;
    return { job, text, skipped };
  }

  async stop(id: string): Promise<boolean> {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`no background job ${id}`);
    return job.code === null ? job.kill() : false;
  }

  /** Jobs that ended since the agent last heard: told once, at the start of its next turn. */
  takeEnded(): Job[] {
    const out = [...this.#jobs.values()].filter((j) => j.code !== null && !j.told);
    for (const j of out) j.told = true;
    return out;
  }

  stopAll(): void {
    for (const j of this.#jobs.values()) if (j.code === null) void j.kill().catch(() => undefined);
  }
}

/** One line about a job, for lists and notices. */
export function describeJob(j: Job): string {
  const secs = Math.round(((j.ended ?? Date.now()) - j.started) / 1000);
  return `${j.id} (pid ${j.pid}) ${j.code === null ? `running for ${secs} s` : `ended with exit code ${j.code} after ${secs} s`}: ${j.command}`;
}
