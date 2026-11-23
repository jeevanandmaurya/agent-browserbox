import { DEFAULT_PROFILE, deleteProfile, getProfile, listProfiles, updateProfile, type LockState } from '@jeevanand/agent-browserbox-runtime/client';
import { PROFILE } from '@/app/boot';
import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { debounce, h } from '@/ui/dom';
import { profileList, signOut } from '@/ui/profiles';
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
                    onclick: () => void signOut(os),
                  },
                  'Sign out',
                ),
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

    body.replaceChildren(
      h('div', { class: 'field' }, h('label', { for: nameId }, 'Profile name'), name, h('p', { class: 'muted st-note' }, id === DEFAULT_PROFILE ? 'The first profile, with the data BrowserBox had before profiles.' : 'Shown in the profile list.')),
      pwBox,
      others,
    );
  })();
  return h('div', { class: 'st-section' }, heading('Profile', 'Who is using BrowserBox. Each profile has its own files, settings, API keys and chats.'), body);
}
