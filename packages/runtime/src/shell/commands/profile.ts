import { createProfile, DEFAULT_PROFILE, deleteProfile, getProfile, listProfiles, updateProfile, type Profile } from '../../kernel/profiles';
import type { Command, CommandContext } from '../shell';
import { C } from '../ansi';

/**
 * Profiles from the terminal: who is using this BrowserBox, other profiles,
 * the password, signing out. Switching and closing need the window showing
 * the terminal; the command asks it to (a terminal action).
 */

const currentId = (ctx: CommandContext) => ctx.os.instance.profile ?? DEFAULT_PROFILE;

/**
 * Changing profiles is for the people using them: only someone typing at a
 * terminal may do it, never a script or the agent (which could otherwise
 * delete another person's data or lock them out).
 */
function byPerson(ctx: CommandContext, what: string): boolean {
  if (ctx.shell.tty?.interactive) return true;
  ctx.err(`${what} must be typed by a person in a terminal; programs and the agent cannot change profiles.\n`);
  return false;
}

/** A profile by id or name (case-insensitive), or null. */
async function find(query: string): Promise<Profile | null> {
  const all = await listProfiles();
  const q = query.trim().toLowerCase();
  return all.find((p) => p.id === query) ?? all.find((p) => p.name.toLowerCase() === q) ?? null;
}

async function lockState(ctx: CommandContext): Promise<string> {
  const s = await ctx.os.secrets.status().catch(() => 'open');
  return s === 'open' ? 'no password' : s === 'unlocked' ? 'password · signed in' : 'password · signed out';
}

/** Signs the profile out: its keys lock, and every window of it shows the sign-in screen. */
async function signOut(ctx: CommandContext): Promise<number> {
  if (!byPerson(ctx, 'Signing out')) return 1;
  if ((await ctx.os.secrets.status()) === 'open') {
    ctx.err(`This profile has no password, so there is nothing to lock. Set one with ${C.bold}passwd${C.reset}, or switch with ${C.bold}profile switch <name>${C.reset}.\n`);
    return 1;
  }
  await ctx.os.secrets.lock();
  ctx.os.bus.emit('secrets:lock', { state: await ctx.os.secrets.status() });
  ctx.out('Signed out.\n');
  return 0;
}

export const profileCommand: Command = {
  name: 'profile',
  summary: 'show, list, create, switch, rename or delete profiles',
  usage: 'profile [list | new <name> | switch <name> | rename <name> | delete <name>]',
  async run(ctx) {
    const [sub = 'show', ...rest] = ctx.args;
    const arg = rest.join(' ').trim();
    const here = currentId(ctx);
    const me = (await getProfile(here)) ?? { id: here, name: here, created: 0, password: false };
    switch (sub) {
      case 'show':
        ctx.out(`${C.bold}${me.name}${C.reset} ${C.dim}(${here} · ${await lockState(ctx)})${C.reset}\n`);
        return 0;
      case 'list':
      case 'ls':
        for (const p of await listProfiles()) ctx.out(`${p.id === here ? `${C.green}*${C.reset}` : ' '} ${p.name}${p.password ? ` ${C.dim}(password)${C.reset}` : ''} ${C.dim}${p.id}${C.reset}\n`);
        return 0;
      case 'new':
      case 'add': {
        if (!arg) return ctx.err('usage: profile new <name>\n'), 2;
        if (!byPerson(ctx, 'Creating a profile')) return 1;
        const p = await createProfile(arg);
        ctx.out(`Created ${C.bold}${p.name}${C.reset}. Open it with ${C.bold}profile switch ${p.name.includes(' ') ? `"${p.name}"` : p.name}${C.reset}.\n`);
        return 0;
      }
      case 'switch':
      case 'use': {
        if (!arg) return ctx.err('usage: profile switch <name>\n'), 2;
        if (!byPerson(ctx, 'Switching profiles')) return 1;
        const p = await find(arg);
        if (!p) return ctx.err(`No profile "${arg}". See profile list.\n`), 1;
        if (p.id === here) return ctx.out(`Already ${p.name}.\n`), 0;
        ctx.out(`Opening ${p.name}…\n`);
        ctx.shell.tty!.action?.({ kind: 'profile', id: p.id });
        return 0;
      }
      case 'rename': {
        if (!arg) return ctx.err('usage: profile rename <new name>\n'), 2;
        if (!byPerson(ctx, 'Renaming a profile')) return 1;
        const p = await updateProfile(here, { name: arg });
        ctx.os.settings.set('profile.name', p.name);
        ctx.out(`This profile is now ${C.bold}${p.name}${C.reset}.\n`);
        return 0;
      }
      case 'delete':
      case 'rm': {
        if (!arg) return ctx.err('usage: profile delete <name>\n'), 2;
        if (!byPerson(ctx, 'Deleting a profile')) return 1;
        const p = await find(arg);
        if (!p) return ctx.err(`No profile "${arg}". See profile list.\n`), 1;
        if (p.id === here) return ctx.err('This is the profile you are using: switch to another one first.\n'), 1;
        if (p.id === DEFAULT_PROFILE) return ctx.err('The first profile holds the data BrowserBox had before profiles and cannot be deleted.\n'), 1;
        {
          const answer = await ctx.shell.tty!.readLine(`Delete ${C.bold}${p.name}${C.reset} with its files, settings, keys and chats? Close its windows first. Type its name to confirm: `);
          if (answer?.trim().toLowerCase() !== p.name.toLowerCase()) return ctx.out('Not deleted.\n'), 1;
        }
        await deleteProfile(p.id);
        ctx.out(`Deleted ${p.name}.\n`);
        return 0;
      }
      default:
        ctx.err(`profile: unknown command "${sub}"\nusage: ${profileCommand.usage}\n`);
        return 2;
    }
  },
};

export const passwdCommand: Command = {
  name: 'passwd',
  summary: "set, change or remove (-d) this profile's password",
  usage: 'passwd [-d]',
  async run(ctx) {
    if (!byPerson(ctx, 'Changing the password')) return 1;
    const tty = ctx.shell.tty!;
    const here = currentId(ctx);
    if ((await ctx.os.secrets.status()) !== 'open') {
      // Changing or removing needs the current password, even while signed in.
      const current = await tty.readLine('Current password: ', { secret: true });
      if (current === null) return 1;
      if (!(await ctx.os.secrets.unlock(current))) return ctx.err('That password is not right.\n'), 1;
    } else if (ctx.args.includes('-d')) return ctx.out('This profile has no password.\n'), 0;
    if (ctx.args.includes('-d')) {
      await ctx.os.secrets.setPassword(null);
      await updateProfile(here, { password: false });
      ctx.os.bus.emit('secrets:lock', { state: 'open' });
      ctx.out('Password removed.\n');
      return 0;
    }
    const next = await tty.readLine('New password: ', { secret: true });
    if (!next) return ctx.out('Unchanged.\n'), 1;
    if (next.length < 4) return ctx.err('Use at least 4 characters.\n'), 1;
    if ((await tty.readLine('Repeat it: ', { secret: true })) !== next) return ctx.err('The two passwords differ. Unchanged.\n'), 1;
    await ctx.os.secrets.setPassword(next);
    await updateProfile(here, { password: true });
    ctx.os.bus.emit('secrets:lock', { state: 'unlocked' });
    ctx.out(`Password set. ${C.bold}signout${C.reset} locks this profile's keys until it is entered again.\n`);
    return 0;
  },
};

export const signoutCommand: Command = { name: 'signout', summary: "sign out: lock this profile's API keys until its password is entered", run: signOut };
export const logoutCommand: Command = { name: 'logout', summary: 'same as signout', run: signOut };

export const exitCommand: Command = {
  name: 'exit',
  summary: 'close this terminal',
  usage: 'exit [code]',
  async run(ctx) {
    const code = Number(ctx.args[0] ?? 0) || 0;
    ctx.shell.tty?.action?.({ kind: 'exit', code });
    return code;
  },
};

export const profileCommands: Command[] = [profileCommand, passwdCommand, signoutCommand, logoutCommand, exitCommand];
