import { SerialHost, serialAvailable, type SerialPortInfo } from '@jeevanand/agent-browserbox-runtime/client';
import { Receiver, RECEIVED_DIR, Sender, transferAvailable, type Progress } from '@/app/transfer';
import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { errText, heading } from './nav';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const progressText = (p: Progress) => `${p.files} of ${p.totalFiles} files · ${fmt(p.bytes)} of ${fmt(p.totalBytes)}${p.name ? ` · ${p.name}` : ''}`;

/**
 * Settings → Devices: serial devices the terminal and the agent can talk to,
 * and sending files straight to another device's BrowserBox.
 */
export function devicesSection(ctx: AppContext, saved: () => void): HTMLElement {
  return h('div', { class: 'st-section' }, heading('Devices', 'Hardware connected to this computer, and your other devices.'), serialPanel(ctx, saved), transferPanel(ctx));
}

function serialPanel(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const box = h('div', { class: 'st-panel' });
  if (!serialAvailable()) {
    box.append(h('h3', null, 'Serial devices'), h('p', { class: 'muted st-note' }, 'This browser has no Web Serial. Chrome, Edge and Opera on a computer have it.'));
    return box;
  }
  // The window's serial host (the kernel's `serial` command goes through it too).
  const serial = (os as { serial?: SerialHost }).serial ?? new SerialHost();
  const status = h('p', { class: 'st-note', role: 'status' });
  const list = h('div', { class: 'st-sched' });
  const log = h('pre', { class: 'st-serial-log', 'aria-label': 'Received from the device', tabindex: 0 });
  const baud = h('select', { class: 'select', 'aria-label': 'Baud rate' }, [9600, 19200, 38400, 57600, 115200, 230400, 921600].map((b) => h('option', { value: String(b), selected: b === 115200 }, String(b))));
  const line = h('input', { class: 'input mono', placeholder: 'Send a line', 'aria-label': 'Line to send' });
  let watching: { index: number; stop: boolean } | null = null;

  const render = async () => {
    let ports: SerialPortInfo[] = [];
    try {
      ports = await serial.list();
    } catch (err) {
      status.textContent = errText(err);
    }
    list.replaceChildren(
      ...(ports.length
        ? ports.map((p) =>
            h(
              'div',
              { class: 'st-sched-item' },
              h('div', { class: 'st-sched-head' }, h('strong', null, `#${p.index} ${p.label}`), h('span', { class: 'badge' }, p.open ? `Open · ${p.baudRate}` : 'Closed')),
              h(
                'div',
                { class: 'row st-wrap' },
                h('button', { class: 'btn small', type: 'button', onclick: () => void monitor(p.index) }, watching?.index === p.index ? 'Monitoring' : 'Monitor'),
                h('button', { class: 'btn small', type: 'button', onclick: () => void serial.close(p.index).then(render) }, 'Close'),
                h(
                  'button',
                  {
                    class: 'btn small',
                    type: 'button',
                    onclick: async () => {
                      if (!(await confirmDialog(`Forget #${p.index}?`, 'BrowserBox will need your permission again to use it.', 'Forget', true))) return;
                      await serial.forget(p.index).catch((err: unknown) => (status.textContent = errText(err)));
                      saved();
                      await render();
                    },
                  },
                  'Forget',
                ),
              ),
            ),
          )
        : [h('p', { class: 'muted st-note' }, 'No device connected yet.')]),
    );
  };

  /** Shows what a device sends, until another is picked or the page closes. */
  const monitor = async (index: number) => {
    if (watching) watching.stop = true;
    const w = (watching = { index, stop: false });
    log.textContent = '';
    try {
      await serial.open(index, Number(baud.value));
      await render();
      status.textContent = `Monitoring #${index} at ${baud.value} baud. In a terminal: serial read ${index}, serial send ${index} …`;
      while (!w.stop && !ctx.proc.signal.aborted) {
        const text = await serial.read(index, 300);
        if (text) {
          log.textContent = (log.textContent + text).slice(-20000);
          log.scrollTop = log.scrollHeight;
        }
      }
    } catch (err) {
      status.textContent = errText(err);
      if (watching === w) watching = null;
    }
  };

  const send = async () => {
    if (!watching) return void (status.textContent = 'Monitor a device first.');
    try {
      await serial.send(watching.index, `${line.value}\r\n`);
      line.value = '';
    } catch (err) {
      status.textContent = errText(err);
    }
  };
  line.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), void send()));

  box.append(
    h('h3', null, 'Serial devices'),
    h('p', { class: 'muted st-note' }, 'Microcontrollers (Arduino, ESP32, Raspberry Pi Pico), modems and instruments over USB serial. Connect one here once; then the terminal’s serial command, and the agent with your approval, can talk to it.'),
    h(
      'div',
      { class: 'row st-wrap' },
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            try {
              const p = await serial.grant();
              status.textContent = `Connected #${p.index} ${p.label}.`;
              saved();
            } catch (err) {
              if ((err as DOMException).name !== 'NotFoundError') status.textContent = errText(err);
            }
            await render();
          },
        },
        'Connect a device…',
      ),
      baud,
    ),
    list,
    log,
    h('div', { class: 'row st-wrap' }, line, h('button', { class: 'btn small', type: 'button', onclick: () => void send() }, 'Send')),
    status,
  );
  void render();
  ctx.proc.signal.addEventListener('abort', () => watching && (watching.stop = true));
  return box;
}

function transferPanel(ctx: AppContext): HTMLElement {
  const { os } = ctx;
  const box = h('div', { class: 'st-panel' }, h('h3', null, 'Send to another device'));
  if (!transferAvailable()) return box.appendChild(h('p', { class: 'muted st-note' }, 'This browser cannot connect devices directly (WebRTC).')), box;
  const status = h('p', { class: 'st-note', role: 'status', 'aria-live': 'polite' });
  const say = (t: string, error = false) => ((status.className = error ? 'st-note st-error' : 'st-note'), (status.textContent = t));
  const stun = h('input', { type: 'checkbox' });
  const codeOut = h('textarea', { class: 'textarea mono', rows: 3, readonly: true, 'aria-label': 'Your code', hidden: true });
  const codeIn = h('textarea', { class: 'textarea mono', rows: 3, 'aria-label': 'The other device’s code', placeholder: 'Paste the other device’s code here' });
  const folder = h('input', { class: 'input mono', value: '/home/user', 'aria-label': 'Folder or file to send' });
  const copy = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => void navigator.clipboard?.writeText(codeOut.value).then(() => say('Code copied.')) }, 'Copy code');
  let sender: Sender | null = null;
  let receiver: Receiver | null = null;
  const show = (code: string) => {
    codeOut.value = code;
    codeOut.hidden = false;
    copy.hidden = false;
    codeOut.select();
  };
  const reset = () => {
    sender?.close();
    receiver?.close();
    sender = receiver = null;
  };

  const sendBtn = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        reset();
        try {
          if (!(await os.fs.exists(folder.value.trim()))) return say(`${folder.value} does not exist.`, true);
          say('Making a code…');
          sender = new Sender(os, { stun: stun.checked });
          show(await sender.code());
          say('Step 1: give this code to the other device (Settings → Devices → Receive). Step 2: paste its reply code below and press Connect and send.');
        } catch (err) {
          say(errText(err), true);
        }
      },
    },
    'Send…',
  );
  const connect = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        const code = codeIn.value.trim();
        if (!code) return say('Paste the other device’s code first.', true);
        try {
          if (sender) {
            const s = sender;
            say('Connecting…');
            const p = await s.send(code, folder.value.trim(), (p) => say(`Sending: ${progressText(p)}`));
            say(`Sent ${p.totalFiles} files (${fmt(p.totalBytes)}).`);
            reset();
          } else {
            receiver = new Receiver(os, { stun: stun.checked });
            const r = receiver;
            show(await r.reply(code));
            say('Give this reply code to the sending device. Waiting for the files…');
            const got = await r.receive((p) => say(`Receiving: ${progressText(p)}`));
            say(`Received ${got.progress.totalFiles} files (${fmt(got.progress.totalBytes)}) in ${got.dir}.`);
            reset();
          }
        } catch (err) {
          say(errText(err), true);
        }
      },
    },
    'Connect',
  );

  box.append(
    h('p', { class: 'muted st-note' }, `Copies a folder from this BrowserBox straight to another device’s, with no server in between. The devices swap a code each (paste them in a message to yourself). Received files go to ${RECEIVED_DIR}.`),
    h('div', { class: 'row st-wrap' }, folder, sendBtn),
    codeIn,
    h('div', { class: 'row st-wrap' }, connect, h('span', { class: 'muted' }, 'On the sending device: paste the reply and Connect. On the receiving device: paste the code and Connect.')),
    codeOut,
    copy,
    h('label', { class: 'st-check' }, stun, 'Use a public STUN server (Google’s), needed when the devices are on different networks. It sees their network addresses, not the files.'),
    status,
  );
  ctx.proc.signal.addEventListener('abort', reset);
  return box;
}
