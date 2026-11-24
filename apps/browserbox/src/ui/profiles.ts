import { passkeyProblem, passkeysAvailable, usePasskey } from '@/app/passkeys';
import { createProfile, listProfiles, type Profile, type RemoteKernel } from '@jeevanand/agent-browserbox-runtime/client';
import { PROFILE, switchProfile } from '@/app/boot';
import { modal } from './dialog';
import { h } from './dom';
import { mark } from './icons';

/**
 * Profiles in the app: who is using BrowserBox. Each profile is a kernel of
 * its own (files, settings, API keys, chats). A profile with a password is
 * signed in until someone signs out; its keys are locked until then.
 */

const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

/** A round badge with the profile's first letter. */
export function avatar(name: string, size = 28): HTMLElement {
  return h(
    'span',
    {
      class: 'pf-avatar',
      style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`,
      'aria-hidden': 'true',
    },
    initial(name),
  );
}

/** The profiles as buttons (pick one to open it), and a form for a new one. */
export function profileList(current: string, opts: { onPicked?: () => void } = {}): HTMLElement {
  const list = h('div', { class: 'pf-list', role: 'list' });
  const render = (profiles: Profile[]) =>
    list.replaceChildren(
      ...profiles.map((p) =>
        h(
          'button',
          {
            class: `pf-item${p.id === current ? ' current' : ''}`,
            type: 'button',
            role: 'listitem',
            'aria-current': p.id === current ? 'true' : undefined,
            onclick: () => {
              opts.onPicked?.();
              if (p.id !== current) void switchProfile(p.id);
            },
          },
          avatar(p.name),
          h('span', { class: 'pf-name' }, p.name),
          p.password ? h('span', { class: 'badge' }, 'password') : null,
          p.id === current ? h('span', { class: 'muted pf-here' }, 'current') : null,
        ),
      ),
    );
  void listProfiles().then(render);

  const name = h('input', {
    class: 'input',
    placeholder: 'Name',
    'aria-label': 'Name of the new profile',
    maxlength: 40,
    autocomplete: 'off',
  });
  const error = h('p', { class: 'st-error', role: 'alert', hidden: true });
  const create = async () => {
    try {
      const p = await createProfile(name.value);
      opts.onPicked?.();
      await switchProfile(p.id);
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && void create());
  return h(
    'div',
    { class: 'pf-chooser' },
    list,
    h('div', { class: 'pf-new' }, name, h('button', { class: 'btn', type: 'button', onclick: () => void create() }, 'New profile')),
    error,
    h('p', { class: 'muted st-note' }, 'Each profile has its own files, settings, API keys and chats. A new one starts empty and asks a few questions on its first start.'),
  );
}

/** Opens the profile chooser as a dialog. */
export async function chooseProfile(): Promise<void> {
  const current = await PROFILE;
  let close = () => undefined as void;
  const box = h(
    'div',
    { class: 'modal pf-modal', role: 'dialog', 'aria-label': 'Profiles' },
    h('h3', null, 'Profiles'),
    profileList(current, { onPicked: () => close() }),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')),
  );
  close = modal(box, () => close());
  box.querySelector<HTMLElement>('.pf-item.current, .pf-item')?.focus();
}

/** Signs the profile out (when it has a password) and shows the sign-in screen. */
export async function signOut(os: { secrets: { lock(): Promise<void> } }): Promise<void> {
  await os.secrets.lock();
  location.reload();
}

/** The sign-in screen of a locked profile. Resolves once the password is right. */
function signInScreen(os: RemoteKernel, root: HTMLElement, profile: Profile): Promise<void> {
  return new Promise((resolve) => {
    const password = h('input', {
      class: 'input',
      type: 'password',
      autocomplete: 'current-password',
      'aria-label': 'Password',
      placeholder: 'Password',
      autofocus: true,
    });
    const error = h('p', { class: 'st-error', role: 'alert', hidden: true });
    const button = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const others = h('div', { class: 'pf-others', hidden: true }, profileList(profile.id));
    const form = h(
      'form',
      {
        class: 'pf-signin-form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (!password.value) return;
          button.disabled = true;
          error.hidden = true;
          const ok = await os.secrets.unlock(password.value).catch(() => false);
          button.disabled = false;
          if (ok) return resolve();
          error.textContent = 'That password is not right.';
          error.hidden = false;
          password.select();
        },
      },
      password,
      button,
    );
    // A passkey instead of the password, where this profile has one.
    const passkeyBtn = h('button', { class: 'btn', type: 'button', hidden: true }, 'Sign in with a passkey');
    passkeyBtn.addEventListener('click', async () => {
      const keys = (await os.secrets.passkeys?.().catch(() => [])) ?? [];
      passkeyBtn.disabled = true;
      error.hidden = true;
      try {
        const got = await usePasskey(keys);
        if (await os.secrets.unlockWithPasskey!(got.id, got.prf)) return resolve();
        error.textContent = 'That passkey does not unlock this profile. Use the password.';
        error.hidden = false;
      } catch (err) {
        const why = passkeyProblem(err);
        if (why) {
          error.textContent = why;
          error.hidden = false;
        }
      } finally {
        passkeyBtn.disabled = false;
      }
    });
    if (passkeysAvailable() && os.secrets.passkeys) void os.secrets.passkeys().then((k) => (passkeyBtn.hidden = !k.length)).catch(() => undefined);
    root.replaceChildren(
      h(
        'div',
        { class: 'pf-signin' },
        h(
          'div',
          { class: 'pf-card' },
          mark(36),
          avatar(profile.name, 56),
          h('h2', null, profile.name),
          h('p', { class: 'muted' }, 'Signed out. Enter the password to use this profile’s keys and chats.'),
          form,
          passkeyBtn,
          error,
          h(
            'button',
            {
              class: 'btn link',
              type: 'button',
              onclick: () => (others.hidden = !others.hidden),
            },
            'Use another profile',
          ),
          others,
        ),
      ),
    );
    password.focus();
  });
}

/**
 * Runs before the app's UI: a signed-out profile shows the sign-in screen
 * first. Afterwards, signing out in any window of this profile brings every
 * window back here.
 */
export async function profileGate(os: RemoteKernel, root: HTMLElement): Promise<void> {
  const id = await PROFILE;
  if ((await os.secrets.status().catch(() => 'open')) === 'locked') {
    const profile = (await listProfiles()).find((p) => p.id === id) ?? {
      id,
      name: 'Profile',
      created: 0,
      password: true,
    };
    await signInScreen(os, root, profile);
  }
  os.bus.on('secrets:lock', ({ state }) => state === 'locked' && location.reload());
}
