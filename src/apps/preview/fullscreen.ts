import { h } from '@/ui/dom';
import { icon } from '@/ui/icons';

/**
 * Full screen for whatever Preview is showing. Uses the Fullscreen API where
 * the browser allows it for this element; elsewhere (iPhone Safari only takes
 * video full screen) the view is pinned over the whole window instead.
 * Esc, the floating button, or the toolbar button leaves it.
 */
export function fullscreenToggle(target: HTMLElement): { button: HTMLButtonElement; dispose(): void } {
  let pinned = false;
  const exitPill = h('button', { class: 'pv-fs-exit', type: 'button', 'aria-label': 'Exit full screen', title: 'Exit full screen (Esc)', onclick: () => void leave() }, icon('fullscreenExit', 16), h('span', null, 'Exit'));
  const button = h('button', { class: 'btn small ghost pv-icon-btn', type: 'button', title: 'Full screen', 'aria-label': 'Full screen', 'aria-pressed': 'false', onclick: () => void (active() ? leave() : enter()) }, icon('fullscreen', 15)) as HTMLButtonElement;

  const active = () => pinned || document.fullscreenElement === target;
  const sync = () => {
    const on = active();
    button.setAttribute('aria-pressed', String(on));
    target.classList.toggle('pv-fs', on);
    if (on) {
      if (!exitPill.isConnected) target.append(exitPill);
      // The button fades after a moment so it does not sit over the app.
      exitPill.classList.remove('dim');
      setTimeout(() => exitPill.classList.add('dim'), 2000);
    } else exitPill.remove();
  };
  async function enter(): Promise<void> {
    try {
      if (!target.requestFullscreen || !document.fullscreenEnabled) throw new Error('unsupported');
      await target.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      pinned = true;
      target.classList.add('pv-pinned');
      sync();
    }
  }
  async function leave(): Promise<void> {
    if (pinned) {
      pinned = false;
      target.classList.remove('pv-pinned');
      sync();
    } else if (document.fullscreenElement === target) await document.exitFullscreen().catch(() => undefined);
  }
  const onKey = (e: KeyboardEvent) => pinned && e.key === 'Escape' && (e.preventDefault(), void leave());
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('keydown', onKey);
  return {
    button,
    dispose() {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('keydown', onKey);
      if (active()) void leave();
    },
  };
}
