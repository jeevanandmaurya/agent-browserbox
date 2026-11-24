import { agentsOf } from '@/app/agents';
import { builtinAvailability, DEFAULT_CONFIG, API_PRESETS, LOCAL_PRESETS, SEARCH_SERVICES, SECRET, hasServerWebTools, loadConfig, protocolOf, saveConfig, type AgentConfig, type ProviderId, type WebSearchService } from '@jeevanand/agent-browserbox/ui';
import type { AppContext } from '@/ui/apps';
import { debounce, h } from '@/ui/dom';
import { keyField } from './keyfield';
import { webllmManager } from './webllm';
import { errText, heading, nextId } from './nav';

const PROVIDERS: Array<{ id: ProviderId; title: string; text: string }> = [
  { id: 'api', title: 'API', text: 'A hosted model with an API key: Anthropic, OpenAI, OpenRouter, Groq and others.' },
  { id: 'local', title: 'Local server', text: 'Ollama, LM Studio, llama.cpp or vLLM on your machine or network.' },
  { id: 'webgpu', title: 'In this browser', text: 'A small model on WebGPU. Offline after the first download.' },
  { id: 'builtin', title: 'Built into the browser', text: 'The browser’s own on-device model (Chrome’s Prompt API). No download by you, no key, offline.' },
];

/** A labelled control. */
function field(label: string, control: HTMLElement, hint?: HTMLElement | string): HTMLElement {
  const id = control.id || (control.id = nextId('f'));
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? (typeof hint === 'string' ? h('p', { class: 'muted st-note' }, hint) : hint) : null);
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

  // ---- Local server and hosted API: same protocol, different expectations
  panels.set('api', serverPanel('api'));
  panels.set('local', serverPanel('local'));

  function serverPanel(kind: 'local' | 'api'): HTMLElement {
    const local = kind === 'local';
    const presets = local ? LOCAL_PRESETS : API_PRESETS;
    const get = () => (local ? { url: cfg.localBaseUrl, model: cfg.localModel } : { url: cfg.apiBaseUrl, model: cfg.apiModel });
    const put = (p: { url?: string; model?: string }) =>
      save(local ? { ...(p.url !== undefined && { localBaseUrl: p.url }), ...(p.model !== undefined && { localModel: p.model }) } : { ...(p.url !== undefined && { apiBaseUrl: p.url }), ...(p.model !== undefined && { apiModel: p.model }) });

    const baseUrl = h('input', { class: 'input mono', type: 'url', value: get().url, placeholder: presets[0].baseUrl, autocomplete: 'off' });
    const hint = h('p', { class: 'muted st-note' });
    let lastPreset: (typeof presets)[number] | undefined = presets.find((p) => p.baseUrl === get().url);
    const mixed = h('p', { class: 'st-warn st-note', hidden: true }, 'This page is served over https, so the browser blocks plain http:// addresses other than localhost.');
    const presetBtns = presets.map((p) =>
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          onclick: () => {
            // Another service: the old model id means nothing there, so start from its default (or none).
            const other = p !== lastPreset;
            baseUrl.value = p.baseUrl;
            saveBase();
            if (other || !model.value.trim()) {
              model.value = 'model' in p ? p.model : '';
              saveModel();
              found.hidden = true;
              datalist.replaceChildren();
              probeStatus.textContent = '';
            }
          },
        },
        p.label,
      ),
    );
    const syncHint = () => {
      const url = baseUrl.value.trim().replace(/\/+$/, '');
      const preset = presets.find((p) => p.baseUrl === url);
      hint.textContent = preset ? `${preset.label}: ${preset.hint}` : local ? 'Any server with /v1/models and /v1/chat/completions.' : 'Anthropic’s API, or any hosted API with /v1/models and /v1/chat/completions that allows browser requests.';
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
      lastPreset = presets.find((p) => p.baseUrl === v.replace(/\/+$/, ''));
      syncHint();
      if (v && v !== get().url) {
        put({ url: v });
        if (!local) keySlot.replaceChildren(apiKeyField());
      }
    };
    baseUrl.addEventListener('input', debounce(saveBase, 500));
    baseUrl.addEventListener('input', syncHint);
    baseUrl.addEventListener('change', saveBase);
    syncHint();

    const listId = nextId('models');
    const datalist = h('datalist', { id: listId });
    const model = h('input', { class: 'input mono', value: get().model, placeholder: local ? 'e.g. qwen2.5-coder:7b' : 'e.g. claude-opus-5-5 or gpt-5.1-mini', autocomplete: 'off' });
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
    // API keys are kept per service, so the key field follows the address.
    const apiKeyField = () =>
      keyField(ctx, {
        secret: local ? SECRET.local : SECRET.api(get().url),
        label: local ? 'API key (optional)' : `API key for ${get().url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`,
        placeholder: local ? 'Only if your server requires one' : protocolOf(get().url) === 'anthropic' ? 'sk-ant-…' : 'sk-…',
        note: 'Stored encrypted; sent only to the address above.',
        onSaved: saved,
      });
    const keySlot = h('div', null, apiKeyField());
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
      keySlot,
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
  panels.set('webgpu', h('div', { class: 'st-panel' }, webllmManager(ctx, () => cfg, save)));
  // ---- The browser's own model: only says whether this browser has it.
  const builtinNote = h('p', { class: 'st-note', role: 'status' }, 'Checking this browser…');
  void builtinAvailability().then((a) => {
    builtinNote.className = a === 'unavailable' ? 'st-note st-error' : 'st-note';
    builtinNote.textContent = {
      available: 'Ready: this browser has its model downloaded.',
      downloadable: 'This browser can download its model (a few GB, once) when you first send a message.',
      downloading: 'This browser is downloading its model.',
      unavailable: 'Not available in this browser. It is in Chrome on desktop (138 or later) on devices with enough memory and disk space.',
    }[a];
  });
  panels.set('builtin', h('div', { class: 'st-panel' }, builtinNote, h('p', { class: 'muted st-note' }, 'A small model, like the WebGPU ones: good for short tasks and questions, weaker with many tools and long work. Images are not sent to it.')));
  for (const [pid, el] of panels) el.hidden = pid !== cfg.provider;

  // ---- Common
  // Sub-agents (spawn_agent) can use a cheaper, faster model on the same API.
  const subModel = h('input', { class: 'input mono', value: cfg.subagentModel, placeholder: 'Same as the main model', autocomplete: 'off', 'aria-label': 'Model for sub-agents' });
  const saveSub = () => subModel.value.trim() !== cfg.subagentModel && save({ subagentModel: subModel.value.trim() });
  subModel.addEventListener('input', debounce(saveSub, 500));
  subModel.addEventListener('change', saveSub);
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

  // ---- Web search for models without their own (Anthropic's API has it built in)
  const serverNote = h('p', { class: 'muted st-note', role: 'status' });
  const syncServerNote = () => {
    serverNote.textContent = hasServerWebTools(cfg)
      ? 'The model you use now (Anthropic’s API) searches and reads the web on Anthropic’s side; these settings apply to the other models.'
      : 'The agent searches and reads the web from this browser. Most search engines do not accept requests from web pages; these do, with your key.';
  };
  syncServerNote();
  const service = h(
    'select',
    { class: 'select', onchange: () => save({ webSearch: service.value as WebSearchService }) },
    h('option', { value: 'auto' }, 'Automatic: the first service below with a key, else Wikipedia'),
    ...SEARCH_SERVICES.map((s) => h('option', { value: s.id }, s.name)),
    h('option', { value: 'wikipedia' }, 'Wikipedia only (no key)'),
    h('option', { value: 'off' }, 'Off'),
  ) as HTMLSelectElement;
  service.value = cfg.webSearch;
  const reader = h('input', { type: 'checkbox', checked: cfg.jinaReader, onchange: () => save({ jinaReader: reader.checked }) });
  const searchKeys = SEARCH_SERVICES.map((s) =>
    keyField(ctx, { secret: s.secret, label: `${s.name} key`, placeholder: `Key from ${s.site.replace(/^https:\/\//, '')}`, note: `${s.hint} Stored encrypted; sent only to ${s.name}.`, onSaved: saved }),
  );

  return h(
    'div',
    { class: 'st-section' },
    heading('Model'),
    chooser,
    ...panels.values(),
    h('h3', null, 'Agent behaviour'),
    field('Model for sub-agents (API only)', subModel, 'A model id on the same API for sub-agents, e.g. a faster, cheaper one for exploring. Custom agents can name their own with model: in their file.'),
    field('Max steps per message', maxSteps, 'Upper limit on model ↔ tool round trips before the agent stops and reports back.'),
    field('Extra instructions', instructions, 'Appended to the agent’s system prompt.'),
    h('h3', null, 'Web search'),
    serverNote,
    field('Search with', service, 'Queries go to the service you choose. Without a key, the agent can only search Wikipedia, and tells you so.'),
    ...searchKeys,
    h('label', { class: 'st-check' }, reader, 'Read pages that refuse web pages through Jina Reader (r.jina.ai)'),
    h('p', { class: 'muted st-note' }, 'Many sites do not let a web page read them. With this on, the agent reads them through Jina Reader, which then sees the page’s address (not your files or keys). Works without a key, with a rate limit; a Jina key above raises it.'),
    h('h3', null, 'Context'),
    h('label', { class: 'st-check' }, autoCompact, 'Summarise the conversation automatically when the context window is 85% full'),
    h('p', { class: 'muted st-note' }, 'The summary replaces the older messages for the model; the full history stays visible in the chat. You can also compact any time with /compact or the meter in the header.'),
    field('Context window for models that do not report it (tokens)', ctxWindow, 'Local servers and most APIs do not report this. Use the context size you started the model with (for Ollama, num_ctx). Anthropic models and in-browser models are set automatically.'),
  );
}
