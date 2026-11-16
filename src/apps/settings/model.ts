import {
  ANTHROPIC_MODELS,
  DEFAULT_CONFIG,
  LOCAL_PRESETS,
  SECRET,
  WEBLLM_MODELS,
  loadConfig,
  probeOpenAi,
  saveConfig,
  type AgentConfig,
  type Effort,
  type ProviderId,
} from '@/agent/config';
import type { AppContext } from '@/ui/apps';
import { debounce, h } from '@/ui/dom';
import { keyField } from './keyfield';
import { errText, heading, nextId } from './nav';

const CUSTOM = '__custom__';
const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: 'low', label: 'Low — quickest, fewest tokens' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High — recommended' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max — most thorough, slowest' },
];

const PROVIDERS: Array<{ id: ProviderId; title: string; text: string }> = [
  { id: 'anthropic', title: 'Claude (Anthropic API)', text: 'The most capable option. Needs an Anthropic API key; requests go straight from this browser to Anthropic.' },
  { id: 'openai', title: 'Local or OpenAI-compatible server', text: 'Ollama, LM Studio, llama.cpp, vLLM or any server that speaks the OpenAI chat API. Stays on your machine when the server is local.' },
  { id: 'webllm', title: 'In this browser (WebGPU)', text: 'Runs a small open model inside this tab. Fully offline after the first download, but much less capable.' },
];

/** A labelled control. */
function field(label: string, control: HTMLElement, hint?: HTMLElement | string): HTMLElement {
  const id = control.id || (control.id = nextId('f'));
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? (typeof hint === 'string' ? h('p', { class: 'muted st-note' }, hint) : hint) : null);
}

function select(options: Array<{ id: string; label: string }>, value: string, onchange: (v: string) => void): HTMLSelectElement {
  const el = h('select', { class: 'select', onchange: () => onchange(el.value) }, options.map((o) => h('option', { value: o.id }, o.label)));
  el.value = value;
  return el;
}

export function modelSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  let cfg = loadConfig(os);
  const save = (patch: Partial<AgentConfig>) => {
    cfg = saveConfig(os, patch);
    saved();
  };

  // ---- Provider chooser
  const group = nextId('provider');
  const panels = new Map<ProviderId, HTMLElement>();
  const chooser = h(
    'fieldset',
    { class: 'st-choices' },
    h('legend', null, 'Where the agent’s model runs'),
    PROVIDERS.map((p) =>
      h(
        'label',
        { class: 'st-choice' },
        h('input', { type: 'radio', name: group, value: p.id, checked: cfg.provider === p.id, onchange: () => setProvider(p.id) }),
        h('span', null, h('strong', null, p.title), h('span', { class: 'muted' }, p.text)),
      ),
    ),
  );
  function setProvider(id: ProviderId): void {
    save({ provider: id });
    for (const [pid, el] of panels) el.hidden = pid !== id;
  }

  // ---- Anthropic
  const known = ANTHROPIC_MODELS.some((m) => m.id === cfg.anthropicModel);
  const customModel = h('input', { class: 'input mono', placeholder: 'e.g. claude-opus-5-5', value: known ? '' : cfg.anthropicModel, autocomplete: 'off' });
  const customField = field('Custom model id', customModel);
  customField.hidden = known;
  const saveCustom = () => {
    const v = customModel.value.trim();
    if (v && v !== cfg.anthropicModel) save({ anthropicModel: v });
  };
  customModel.addEventListener('input', debounce(saveCustom, 500));
  customModel.addEventListener('change', saveCustom);
  const modelSelect = select([...ANTHROPIC_MODELS, { id: CUSTOM, label: 'Custom model id…' }], known ? cfg.anthropicModel : CUSTOM, (v) => {
    customField.hidden = v !== CUSTOM;
    if (v === CUSTOM) {
      customModel.focus();
      saveCustom();
    } else save({ anthropicModel: v });
  });
  panels.set(
    'anthropic',
    h(
      'div',
      { class: 'st-panel' },
      keyField(ctx, {
        secret: SECRET.anthropic,
        label: 'Anthropic API key',
        placeholder: 'sk-ant-…',
        note: 'The key is encrypted at rest in this browser and sent only to api.anthropic.com. Create one at console.anthropic.com.',
        onSaved: saved,
      }),
      field('Model', modelSelect),
      customField,
      field('Effort', select(EFFORTS, cfg.effort, (v) => save({ effort: v as Effort })), 'How hard Claude thinks before acting. Higher is more thorough but slower and uses more tokens.'),
      h(
        'label',
        { class: 'st-check' },
        h('input', { type: 'checkbox', checked: cfg.webSearch, onchange: (e: Event) => save({ webSearch: (e.target as HTMLInputElement).checked }) }),
        'Allow web search and fetch (runs on Anthropic’s servers)',
      ),
    ),
  );

  // ---- OpenAI-compatible
  const baseUrl = h('input', { class: 'input mono', type: 'url', value: cfg.openaiBaseUrl, placeholder: DEFAULT_CONFIG.openaiBaseUrl, autocomplete: 'off' });
  const hint = h('p', { class: 'muted st-note' });
  const mixed = h('p', { class: 'st-warn st-note', hidden: true }, 'This page is served over https, so the browser will block plain http:// servers other than localhost.');
  const presetBtns = LOCAL_PRESETS.map((p) =>
    h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        onclick: () => {
          baseUrl.value = p.baseUrl;
          saveBase();
        },
      },
      p.label,
    ),
  );
  const syncHint = () => {
    const url = baseUrl.value.trim().replace(/\/+$/, '');
    const preset = LOCAL_PRESETS.find((p) => p.baseUrl === url);
    hint.textContent = preset ? `${preset.label}: ${preset.hint}` : 'Any server exposing /v1/models and /v1/chat/completions.';
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(LOCAL_PRESETS[i] === preset)));
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* incomplete URL while typing */
    }
    mixed.hidden = !(location.protocol === 'https:' && url.startsWith('http://') && !['localhost', '127.0.0.1', '[::1]'].includes(host));
  };
  const saveBase = () => {
    const v = baseUrl.value.trim();
    syncHint();
    if (v && v !== cfg.openaiBaseUrl) save({ openaiBaseUrl: v });
  };
  baseUrl.addEventListener('input', debounce(saveBase, 500));
  baseUrl.addEventListener('input', syncHint);
  baseUrl.addEventListener('change', saveBase);
  syncHint();

  const listId = nextId('models');
  const datalist = h('datalist', { id: listId });
  const openaiModel = h('input', { class: 'input mono', value: cfg.openaiModel, placeholder: 'e.g. qwen2.5-coder:7b', autocomplete: 'off' });
  openaiModel.setAttribute('list', listId); // `list` is a read-only property, so h() cannot set it
  const saveModel = () => {
    const v = openaiModel.value.trim();
    if (v !== cfg.openaiModel) save({ openaiModel: v });
  };
  openaiModel.addEventListener('input', debounce(saveModel, 500));
  openaiModel.addEventListener('change', saveModel);

  const found = h('select', { class: 'select', hidden: true, 'aria-label': 'Models on the server' });
  found.addEventListener('change', () => {
    if (!found.value) return;
    openaiModel.value = found.value;
    saveModel();
  });
  const probeStatus = h('p', { class: 'st-note', 'aria-live': 'polite' });
  const testBtn = h('button', { class: 'btn', type: 'button', onclick: () => void test() }, 'Test connection');

  async function test(): Promise<void> {
    saveBase();
    testBtn.disabled = true;
    probeStatus.className = 'st-note muted';
    probeStatus.textContent = 'Connecting…';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const stop = () => ctl.abort();
    ctx.proc.signal.addEventListener('abort', stop);
    try {
      // The kernel probes with the stored key; windows can never read secrets back.
      const ids = await os.agents.probeModels(cfg.openaiBaseUrl);
      ctl.signal.throwIfAborted();
      datalist.replaceChildren(...ids.map((id) => h('option', { value: id })));
      found.replaceChildren(h('option', { value: '' }, `Choose from ${ids.length} model${ids.length === 1 ? '' : 's'}…`), ...ids.map((id) => h('option', { value: id }, id)));
      found.hidden = ids.length === 0;
      probeStatus.className = 'st-note st-ok';
      probeStatus.textContent = ids.length ? `Connected — ${ids.length} model${ids.length === 1 ? '' : 's'} available.` : 'Connected, but the server lists no models. Pull or load one first.';
      if (ids[0] && !cfg.openaiModel) {
        openaiModel.value = ids[0];
        saveModel();
      }
    } catch (err) {
      probeStatus.className = 'st-note st-error';
      probeStatus.textContent = ctl.signal.aborted && !ctx.proc.signal.aborted ? `No answer from ${cfg.openaiBaseUrl} within 10 seconds.` : errText(err);
    } finally {
      clearTimeout(timer);
      ctx.proc.signal.removeEventListener('abort', stop);
      testBtn.disabled = false;
    }
  }

  panels.set(
    'openai',
    h(
      'div',
      { class: 'st-panel' },
      h('div', { class: 'field' }, h('span', null, 'Presets'), h('div', { class: 'row st-wrap', role: 'group', 'aria-label': 'Server presets' }, presetBtns)),
      field('Base URL', baseUrl, h('div', null, hint, mixed)),
      keyField(ctx, {
        secret: SECRET.openai,
        label: 'API key (optional)',
        placeholder: 'Only if your server requires one',
        note: 'Encrypted at rest in this browser and sent only to the base URL above. Local servers usually need no key.',
        onSaved: saved,
      }),
      h('div', { class: 'row st-wrap' }, testBtn, found),
      probeStatus,
      field('Model', openaiModel, 'The model id as the server names it. Test the connection to pick from a list.'),
      datalist,
    ),
  );

  // ---- WebLLM
  const gpuOk = os.hasCap('webgpu');
  panels.set(
    'webllm',
    h(
      'div',
      { class: 'st-panel' },
      gpuOk
        ? null
        : h('p', { class: 'st-callout' }, h('span', { class: 'badge warn' }, 'WebGPU unavailable'), ' This browser cannot run in-browser models. Use Chrome, Edge or Safari with WebGPU enabled, or pick another option.'),
      field('Model', select([...WEBLLM_MODELS], cfg.webllmModel, (v) => save({ webllmModel: v }))),
      h(
        'p',
        { class: 'muted st-note' },
        'The weights download once on first use (roughly 1–5 GB) and are cached by the browser, so later starts work offline. Larger models need more graphics memory; small models follow complex instructions less reliably.',
      ),
    ),
  );
  for (const [pid, el] of panels) el.hidden = pid !== cfg.provider;

  // ---- Common
  const maxSteps = h('input', { class: 'input st-num', type: 'number', min: 1, max: 500, step: 1, value: String(cfg.maxSteps) });
  maxSteps.addEventListener('change', () => {
    const n = Math.round(Number(maxSteps.value));
    const v = Number.isFinite(n) && n > 0 ? Math.min(500, n) : DEFAULT_CONFIG.maxSteps;
    maxSteps.value = String(v);
    if (v !== cfg.maxSteps) save({ maxSteps: v });
  });
  const instructions = h('textarea', { class: 'textarea', rows: 5, value: cfg.instructions, placeholder: 'e.g. Answer in British English. Prefer Python for scripts.' });
  const saveInstr = () => {
    if (instructions.value !== cfg.instructions) save({ instructions: instructions.value });
  };
  instructions.addEventListener('input', debounce(saveInstr, 600));
  instructions.addEventListener('change', saveInstr);

  return h(
    'div',
    { class: 'st-section' },
    heading('Model', 'Choose the language model that powers the agent. Changes apply to the next message.'),
    chooser,
    ...panels.values(),
    h('h3', null, 'Agent behaviour'),
    field('Max steps per message', maxSteps, 'Upper limit on model ↔ tool round trips before the agent stops and reports back.'),
    field('Extra instructions', instructions, 'Appended to the agent’s system prompt.'),
  );
}
