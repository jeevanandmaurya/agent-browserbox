import type { SettingsApi } from './api';

/** Things a sandboxed actor must be granted before the kernel will do them. */
export type Capability =
  | 'fs.write' // create / modify / delete files
  | 'exec' // run shell commands or code in the sandbox
  | 'net' // outbound network requests
  | 'clipboard'
  | 'notify'
  | 'system'; // open apps, kill processes, speak, etc.

export interface PermRequest {
  cap: Capability;
  /** Who is asking, e.g. "Agent". */
  actor: string;
  /** Short human title, e.g. "Run shell command". */
  title: string;
  /** The exact thing being approved (command, path, URL). */
  detail: string;
}

export type PermDecision = 'once' | 'always' | 'deny';
/** `signal` aborts when the request was answered elsewhere (another window). */
export type Prompter = (req: PermRequest, signal?: AbortSignal) => Promise<PermDecision>;
/**
 * ask: risky actions need a one-off or standing grant. edits: like ask, but
 * the agent's file changes go through (its own judgement, see the agent).
 * auto: everything inside the sandbox is allowed.
 */
export type PermMode = 'ask' | 'edits' | 'auto';
const MODES: PermMode[] = ['ask', 'edits', 'auto'];

/**
 * Capability broker. Policy: in `auto` mode everything inside the sandbox is
 * allowed; in `ask` mode each capability needs a one-off or standing grant.
 */
export class Permissions {
  #prompter: Prompter = async () => 'deny';

  constructor(private settings: SettingsApi) {}

  setPrompter(p: Prompter): void {
    this.#prompter = p;
  }

  /** Shows the installed prompt without consulting or changing grants. */
  prompt(req: PermRequest, signal?: AbortSignal): Promise<PermDecision> {
    return this.#prompter(req, signal);
  }

  get mode(): PermMode {
    const m = this.settings.get<PermMode>('perms.mode', 'ask');
    // A mode this version does not know (written by a newer one) is treated as the safest.
    return MODES.includes(m) ? m : 'ask';
  }
  set mode(m: PermMode) {
    this.settings.set('perms.mode', m);
  }

  grants(): Capability[] {
    return this.settings.get<Capability[]>('perms.grants', []);
  }

  revoke(cap: Capability): void {
    this.settings.set(
      'perms.grants',
      this.grants().filter((c) => c !== cap),
    );
  }

  isGranted(cap: Capability): boolean {
    return this.mode === 'auto' || this.grants().includes(cap);
  }

  /** Resolves true when allowed. `prompter` overrides the UI dialog (used by the CLI). */
  async request(req: PermRequest, prompter?: Prompter): Promise<boolean> {
    if (this.isGranted(req.cap)) return true;
    const decision = await (prompter ?? this.#prompter)(req);
    if (decision === 'always') this.settings.set('perms.grants', [...new Set([...this.grants(), req.cap])]);
    return decision !== 'deny';
  }
}
