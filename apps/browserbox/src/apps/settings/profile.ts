import { DEFAULT_PROFILE, deleteProfile, getProfile, listProfiles, updateProfile, type LockState } from '@jeevanand/agent-browserbox-runtime/client';
import { PROFILE } from '@/app/boot';
import { createPasskey, passkeyProblem, passkeysAvailable } from '@/app/passkeys';
import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { debounce, h } from '@/ui/dom';
import { chooseProfile, deleteThisProfile, profileList, signOut } from '@/ui/profiles';
import { errText, heading, nextId } from './nav';

/**
 * This profile: its name, an optional password (which locks its API keys when
 * someone signs out), and the site's other profiles.
 */
export function profileSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const body = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  void (async () => {
    const id = await PROFILE;
    const me = (await getProfile(id)) ?? {
      id,
      name: 'Profile',
      created: 0,
      password: false,
    };

    // ---- Name
    const nameId = nextId('pf');
    const name = h('input', {
      class: 'input',
      id: nameId,
      value: me.name,
      maxlength: 40,
      autocomplete: 'off',
    });
    const storeName = () =>
      void updateProfile(id, { name: name.value }).then(
        (p) => (os.settings.set('profile.name', p.name), saved(), void renderOthers()),
        () => undefined,
      );
    name.addEventListener('input', debounce(storeName, 500));
    name.addEventListener('change', storeName);
    ctx.on('settings:change', ({ key }) => key === 'profile.name' && document.activeElement !== name && void getProfile(id).then((p) => p && (name.value = p.name)));

    // ---- Password
    const pwBox = h('div', { class: 'st-panel' });
    const renderPassword = async () => {
      const state: LockState = await os.secrets.status().catch(() => 'open');
      const p1 = h('input', {
        class: 'input',
        type: 'password',
        autocomplete: 'new-password',
        'aria-label': 'New password',
        placeholder: 'New password',
      });
      const p2 = h('input', {
        class: 'input',
        type: 'password',
        autocomplete: 'new-password',
        'aria-label': 'Repeat the new password',
        placeholder: 'Repeat it',
      });
      const status = h('p', { class: 'st-note', role: 'status' });
      const set = async (value: string | null) => {
        if (value !== null && value !== p2.value) {
          status.className = 'st-note st-error';
          status.textContent = 'The two passwords differ.';
          return;
        }
        if (value !== null && value.length < 4) {
          status.className = 'st-note st-error';
          status.textContent = 'Use at least 4 characters.';
          return;
        }
        try {
          await os.secrets.setPassword(value);
          await updateProfile(id, { password: value !== null });
          saved();
          await renderPassword();
        } catch (err) {
          status.className = 'st-note st-error';
          status.textContent = errText(err);
        }
      };
      const has = state !== 'open';
      pwBox.replaceChildren(
        ...([
          h('h3', null, 'Password'),
          h(
            'p',
            { class: 'muted st-note' },
            has
              ? 'This profile has a password. Signing out locks its API keys and tokens until the password is entered again; you stay signed in until then.'
              : 'Optional. With a password, signing out locks this profile’s API keys and tokens, so someone else using this browser cannot use them. Files are not encrypted.',
          ),
          h(
            'div',
            { class: 'row st-wrap' },
            p1,
            p2,
            h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onclick: () => void set(p1.value),
              },
              has ? 'Change password' : 'Set password',
            ),
          ),
          has
            ? h(
                'div',
                { class: 'row st-wrap' },
                h(
                  'button',
                  {
                    class: 'btn',
                    type: 'button',
                    onclick: async () => {
                      if (await confirmDialog('Remove the password?', 'Anyone using this browser can then use this profile’s keys without signing in.', 'Remove password', true)) await set(null);
                    },
                  },
                  'Remove password',
                ),
              )
            : null,
          status,
          h('p', { class: 'muted st-note' }, 'There is no way to recover a forgotten password: the keys it protects cannot be read without it. You could then delete them and save them again.'),
        ].filter((x) => x !== null) as HTMLElement[]),
      );
    };
    await renderPassword();

    // ---- Passkeys: sign in with a fingerprint, face or security key instead of the password
    const pkBox = h('div', { class: 'st-panel' });
    const renderPasskeys = async () => {
      const state: LockState = await os.secrets.status().catch(() => 'open');
      if (!os.secrets.passkeys || state === 'open') return void pkBox.replaceChildren();
      if (!passkeysAvailable()) return void pkBox.replaceChildren(h('h3', null, 'Passkeys'), h('p', { class: 'muted st-note' }, 'This browser cannot use passkeys here (they need HTTPS and WebAuthn).'));
      const keys = await os.secrets.passkeys().catch(() => []);
      const status = h('p', { class: 'st-note', role: 'status' });
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Your password', placeholder: 'Your password' });
      const label = h('input', { class: 'input', maxlength: 60, 'aria-label': 'Name for the passkey', placeholder: 'Name, e.g. This laptop' });
      const add = async () => {
        status.className = 'st-note';
        if (!pw.value) {
          status.className = 'st-note st-error';
          status.textContent = 'Enter your password: it unlocks the key the passkey will protect.';
          return;
        }
        try {
          status.textContent = 'Follow your browser’s passkey prompt…';
          const made = await createPasskey({ id, name: me.name });
          const ok = await os.secrets.addPasskey!(pw.value, { id: made.id, label: label.value.trim() || `Passkey ${keys.length + 1}`, input: made.input, prf: made.prf });
          if (!ok) {
            status.className = 'st-note st-error';
            status.textContent = 'That password is not right. The passkey was made but does not unlock anything; you can delete it from your device.';
            return;
          }
          saved();
          await renderPasskeys();
        } catch (err) {
          const why = passkeyProblem(err);
          status.className = why ? 'st-note st-error' : 'st-note';
          status.textContent = why ?? '';
        }
      };
      pkBox.replaceChildren(
        h('h3', null, 'Passkeys'),
        h('p', { class: 'muted st-note' }, 'Sign in with your fingerprint, face, phone or security key instead of typing the password. The password keeps working. Changing or removing the password removes the passkeys.'),
        ...keys.map((k) =>
          h(
            'div',
            { class: 'row st-wrap' },
            h('span', null, `${k.label} · added ${new Date(k.created).toLocaleDateString()}`),
            h(
              'button',
              {
                class: 'btn small',
                type: 'button',
                onclick: async () => {
                  if (!(await confirmDialog(`Remove “${k.label}”?`, 'It will no longer unlock this profile. The passkey itself stays on your device until you delete it there.', 'Remove', true))) return;
                  await os.secrets.removePasskey?.(k.id);
                  saved();
                  await renderPasskeys();
                },
              },
              'Remove',
            ),
          ),
        ),
        h('div', { class: 'row st-wrap' }, label, pw, h('button', { class: 'btn', type: 'button', onclick: () => void add() }, 'Add a passkey')),
        status,
      );
    };
    await renderPasskeys();
    ctx.on('secrets:lock', () => void renderPasskeys());

    // ---- Other profiles
    const others = h('div', { class: 'st-panel' });
    const renderOthers = async () => {
      const deletable = (await listProfiles()).filter((p) => p.id !== id && p.id !== DEFAULT_PROFILE);
      others.replaceChildren(
        ...([
          h('h3', null, 'Profiles'),
          profileList(id),
          deletable.length
            ? h(
                'div',
                { class: 'pf-delete' },
                h('h4', null, 'Delete a profile'),
                ...deletable.map((p) =>
                  h(
                    'div',
                    { class: 'row' },
                    h('span', { class: 'pf-name' }, p.name),
                    h(
                      'button',
                      {
                        class: 'btn small danger',
                        type: 'button',
                        onclick: async () => {
                          if (!(await confirmDialog(`Delete ${p.name}?`, `Its files, settings, API keys and chats are deleted from this browser. Close its windows first. This cannot be undone.`, 'Delete profile', true))) return;
                          try {
                            await deleteProfile(p.id);
                            saved();
                          } catch (err) {
                            os.notify({
                              title: `Could not delete ${p.name}`,
                              body: errText(err),
                              level: 'error',
                            });
                          }
                          await renderOthers();
                        },
                      },
                      'Delete',
                    ),
                  ),
                ),
              )
            : null,
        ].filter((x) => x !== null) as HTMLElement[]),
      );
    };
    await renderOthers();

    // ---- Signing out, switching, deleting
    const accountNote = h('p', { class: 'muted st-note', role: 'status' });
    const account = h(
      'div',
      { class: 'st-panel' },
      h('h3', null, 'This profile'),
      h(
        'div',
        { class: 'row st-wrap' },
        h('button', { class: 'btn', type: 'button', onclick: () => void chooseProfile() }, 'Switch profile…'),
        h('button', {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            if ((await os.secrets.status().catch(() => 'open')) !== 'open') return void signOut(os);
            accountNote.textContent = 'Signing out locks this profile behind its password, and it has none yet: set one above first. (Without a password anyone using this browser can open it, so there is nothing to sign out of; Switch profile changes who is using BrowserBox.)';
            pwBox.querySelector<HTMLInputElement>('input')?.focus();
          },
        }, 'Sign out'),
        id === DEFAULT_PROFILE
          ? null
          : h('button', {
              class: 'btn danger',
              type: 'button',
              onclick: async () => {
                if (!(await confirmDialog(`Delete ${name.value || me.name}?`, 'Its files, settings, API keys and chats are deleted from this browser, and this window opens the first profile. Close this profile’s other windows first. This cannot be undone.', 'Delete profile', true))) return;
                deleteThisProfile(id);
              },
            }, 'Delete this profile…'),
      ),
      accountNote,
      id === DEFAULT_PROFILE ? h('p', { class: 'muted st-note' }, 'The first profile cannot be deleted (it holds the data BrowserBox had before profiles), but it can be renamed and protected with a password.') : null,
    );

    body.replaceChildren(
      h('div', { class: 'field' }, h('label', { for: nameId }, 'Profile name'), name, h('p', { class: 'muted st-note' }, id === DEFAULT_PROFILE ? 'The first profile, with the data BrowserBox had before profiles. Your name (first boot, or Appearance) names it until you rename it here.' : 'Shown in the profile list.')),
      account,
      pwBox,
      pkBox,
      others,
    );
  })();
  return h('div', { class: 'st-section' }, heading('Profile', 'Who is using BrowserBox. Each profile has its own files, settings, API keys and chats.'), body);
}
