import { agentsOf } from '@/app/agents';
import {
  ANTHROPIC_MODELS,
  DEFAULT_CONFIG,
  API_PRESETS,
  LOCAL_PRESETS,
  SECRET,
  loadConfig,
  saveConfig,
  type AgentConfig,
  type Effort,
  type ProviderId,
} from '@jeevanand/agent-browserbox/ui';
import type { AppContext } from '@/ui/apps';
import { debounce, h } from '@/ui/dom';
import { keyField } from './keyfield';
import { webllmManager } from './webllm';
import { errText, heading, nextId } from './nav';

const CUSTOM = '__custom__';
const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: 'low', label: 'Low — quickest, fewest tokens' },
  { id: 'medium', label: 'Medium — default, balanced' },
  { id: 'high', label: 'High — deeper reasoning' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max — most thorough, slowest' },
];

const PROVIDERS: Array<{ id: ProviderId; title: string; text: string }> = [
  { id: 'anthropic', title: 'Claude', text: 'Anthropic API key. Web search included.' },
  { id: 'local', title: 'Local server', text: 'Ollama, LM Studio, llama.cpp or vLLM on your machine or network.' },
  { id: 'openai', title: 'OpenAI-compatible API', text: 'OpenAI, OpenRouter, Groq and similar, with an API key.' },
  { id: 'webllm', title: 'In this browser', text: 'A small model on WebGPU. Offline after the first download.' },
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

  // ---- Local server and hosted API: same protocol, different expectations
  panels.set('local', serverPanel('local'));
  panels.set('openai', serverPanel('openai'));

  function serverPanel(kind: 'local' | 'openai'): HTMLElement {
    const local = kind === 'local';
    const presets = local ? LOCAL_PRESETS : API_PRESETS;
    const get = () => (local ? { url: cfg.localBaseUrl, model: cfg.localModel } : { url: cfg.openaiBaseUrl, model: cfg.openaiModel });
    const put = (p: { url?: string; model?: string }) =>
      save(local ? { ...(p.url !== undefined && { localBaseUrl: p.url }), ...(p.model !== undefined && { localModel: p.model }) } : { ...(p.url !== undefined && { openaiBaseUrl: p.url }), ...(p.model !== undefined && { openaiModel: p.model }) });

    const baseUrl = h('input', { class: 'input mono', type: 'url', value: get().url, placeholder: presets[0].baseUrl, autocomplete: 'off' });
    const hint = h('p', { class: 'muted st-note' });
    const mixed = h('p', { class: 'st-warn st-note', hidden: true }, 'This page is served over https, so the browser blocks plain http:// addresses other than localhost.');
    const presetBtns = presets.map((p) =>
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
      const preset = presets.find((p) => p.baseUrl === url);
      hint.textContent = preset ? `${preset.label}: ${preset.hint}` : local ? 'Any server with /v1/models and /v1/chat/completions.' : 'Any hosted API with /v1/models and /v1/chat/completions that allows browser requests.';
      presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(presets[i] === preset)));
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
      if (v && v !== get().url) put({ url: v });
    };
    baseUrl.addEventListener('input', debounce(saveBase, 500));
    baseUrl.addEventListener('input', syncHint);
    baseUrl.addEventListener('change', saveBase);
    syncHint();

    const listId = nextId('models');
    const datalist = h('datalist', { id: listId });
    const model = h('input', { class: 'input mono', value: get().model, placeholder: local ? 'e.g. qwen2.5-coder:7b' : 'e.g. gpt-5.1-mini', autocomplete: 'off' });
    model.setAttribute('list', listId); // `list` is a read-only property, so h() cannot set it
    const saveModel = () => {
      const v = model.value.trim();
      if (v !== get().model) put({ model: v });
    };
    model.addEventListener('input', debounce(saveModel, 500));
    model.addEventListener('change', saveModel);

    const found = h('select', { class: 'select', hidden: true, 'aria-label': 'Available models' });
    found.addEventListener('change', () => {
      if (!found.value) return;
      model.value = found.value;
      saveModel();
    });
    const probeStatus = h('p', { class: 'st-note', 'aria-live': 'polite' });
    const testBtn = h('button', { class: 'btn', type: 'button', onclick: () => void test() }, 'Test connection');

    async function test(): Promise<void> {
      saveBase();
      testBtn.disabled = true;
      probeStatus.className = 'st-note muted';
      probeStatus.textContent = 'Connecting…';
      try {
        // The kernel probes with the stored key; windows can never read secrets back.
        const ids = await Promise.race([agentsOf(os).probeModels(get().url, kind), new Promise<never>((_, no) => setTimeout(() => no(new Error(`No answer from ${get().url} within 10 seconds.`)), 10_000))]);
        datalist.replaceChildren(...ids.map((id) => h('option', { value: id })));
        found.replaceChildren(h('option', { value: '' }, `Choose from ${ids.length} model${ids.length === 1 ? '' : 's'}…`), ...ids.map((id) => h('option', { value: id }, id)));
        found.hidden = ids.length === 0;
        probeStatus.className = 'st-note st-ok';
        probeStatus.textContent = ids.length ? `Connected · ${ids.length} model${ids.length === 1 ? '' : 's'}` : local ? 'Connected, but no models are loaded. Pull or load one first.' : 'Connected, but no models are listed.';
        if (ids[0] && !get().model) {
          model.value = ids[0];
          saveModel();
        }
      } catch (err) {
        probeStatus.className = 'st-note st-error';
        probeStatus.textContent = errText(err);
      } finally {
        testBtn.disabled = false;
      }
    }

    return h(
      'div',
      { class: 'st-panel' },
      h('div', { class: 'field' }, h('span', null, local ? 'Server' : 'Service'), h('div', { class: 'row st-wrap', role: 'group', 'aria-label': 'Presets' }, presetBtns)),
      field('Base URL', baseUrl, h('div', null, hint, mixed)),
      keyField(ctx, {
        secret: local ? SECRET.local : SECRET.openai,
        label: local ? 'API key (optional)' : 'API key',
        placeholder: local ? 'Only if your server requires one' : 'sk-…',
        note: 'Stored encrypted; sent only to the URL above.',
        onSaved: saved,
      }),
      local ? null : relayField(),
      h('div', { class: 'row st-wrap' }, testBtn, found),
      probeStatus,
      field('Model', model),
      datalist,
    );
  }

  /** For hosted APIs that refuse requests from web pages. */
  function relayField(): HTMLElement {
    const input = h('input', { class: 'input mono', type: 'url', value: cfg.corsRelay, placeholder: 'https://your-relay.workers.dev', autocomplete: 'off' });
    const store = () => input.value.trim() !== cfg.corsRelay && save({ corsRelay: input.value.trim() });
    input.addEventListener('input', debounce(store, 500));
    input.addEventListener('change', store);
    return field(
      'Relay (optional)',
      input,
      h('p', { class: 'muted st-note' }, 'Only for services that do not accept requests from web pages, such as ollama.com. Requests (and your key) pass through it, so use one you run: relay/worker.js in the BrowserBox repository deploys to Cloudflare Workers for free.'),
    );
  }

  // ---- WebLLM: download, use, delete and import in-browser models
  panels.set('webllm', h('div', { class: 'st-panel' }, webllmManager(ctx, () => cfg, save)));
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

  const ctxWindow = h('input', { class: 'input st-num', type: 'number', min: 2048, max: 2000000, step: 1024, value: String(cfg.contextWindow) });
  ctxWindow.addEventListener('change', () => {
    const n = Math.round(Number(ctxWindow.value));
    const v = Number.isFinite(n) && n >= 2048 ? Math.min(2_000_000, n) : DEFAULT_CONFIG.contextWindow;
    ctxWindow.value = String(v);
    if (v !== cfg.contextWindow) save({ contextWindow: v });
  });
  const autoCompact = h('input', { type: 'checkbox', checked: cfg.autoCompact, onchange: () => save({ autoCompact: autoCompact.checked }) });

  return h(
    'div',
    { class: 'st-section' },
    heading('Model'),
    chooser,
    ...panels.values(),
    h('h3', null, 'Agent behaviour'),
    field('Max steps per message', maxSteps, 'Upper limit on model ↔ tool round trips before the agent stops and reports back.'),
    field('Extra instructions', instructions, 'Appended to the agent’s system prompt.'),
    h('h3', null, 'Context'),
    h('label', { class: 'st-check' }, autoCompact, 'Summarise the conversation automatically when the context window is 85% full'),
    h('p', { class: 'muted st-note' }, 'The summary replaces the older messages for the model; the full history stays visible in the chat. You can also compact any time with /compact or the meter in the header.'),
    field('Context window for local and OpenAI-compatible models (tokens)', ctxWindow, 'Local servers do not report this. Use the context size you started the model with (for Ollama, num_ctx). Claude models are set automatically.'),
  );
}
