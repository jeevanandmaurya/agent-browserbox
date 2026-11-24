/**
 * The browser's own on-device model (Chrome's Prompt API, `LanguageModel`).
 * Kept apart from the provider so a window can run prompts for an agent that
 * lives in a worker (the API is not offered in every kind of worker, and a
 * first download needs a recent click in a page).
 */
export interface BuiltinPromptInput {
  /** System message first, then the conversation so far (user/assistant). */
  initialPrompts: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** The new user message. */
  prompt: string;
}

/** 'unavailable', 'downloadable', 'downloading' or 'available'; 'unavailable' where there is no API. */
export type BuiltinAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LmSession {
  promptStreaming(input: string, o?: { signal?: AbortSignal }): ReadableStream<string> & AsyncIterable<string>;
  destroy(): void;
  /** The model's window in tokens (earlier Chrome versions: inputQuota). */
  contextWindow?: number;
  inputQuota?: number;
}

/** What a prompt gave: the reply, and the model's window when the browser says it. */
export interface BuiltinReply {
  text: string;
  window?: number;
}

/** The conversation did not fit the model's window (the agent then retries with less history). */
export class BuiltinTooLarge extends Error {
  constructor(readonly window?: number) {
    super(`The conversation is too long for the browser's built-in model${window ? ` (its window is about ${window} tokens)` : ''}.`);
    this.name = 'BuiltinTooLarge';
  }
}
const tooLarge = (err: unknown) => /too large|quota|exceed|overflow/i.test(String((err as Error)?.message ?? err)) || (err as DOMException)?.name === 'QuotaExceededError';
interface LmStatic {
  availability(o?: object): Promise<BuiltinAvailability>;
  create(o?: object): Promise<LmSession>;
}

const LANGS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
/** The window the browser last reported, used when a session could not even be made. */
let lastWindow: number | undefined;
const api = (): LmStatic | null => ((globalThis as { LanguageModel?: LmStatic }).LanguageModel ?? null);

/** Whether this browser has a built-in model here, and whether it is downloaded. */
export async function builtinAvailability(): Promise<BuiltinAvailability> {
  const LM = api();
  if (!LM) return 'unavailable';
  try {
    return await LM.availability(LANGS);
  } catch {
    return 'unavailable';
  }
}

/** Whether this global scope can run the built-in model itself. */
export const hasBuiltinModel = (): boolean => api() !== null;

/**
 * Runs one prompt on the built-in model, streaming the reply to `onChunk`
 * (and download progress to `onStatus`). Resolves with the whole reply.
 */
export async function runBuiltinPrompt(input: BuiltinPromptInput, o: { signal?: AbortSignal; onChunk?: (text: string) => void; onStatus?: (s: string) => void } = {}): Promise<BuiltinReply> {
  const LM = api();
  if (!LM) throw new Error('This browser has no built-in model (Chrome’s Prompt API).');
  const avail = await LM.availability(LANGS);
  if (avail === 'unavailable') throw new Error('The built-in model is not available on this device (Chrome needs enough disk space, memory and a supported GPU or CPU).');
  let session: LmSession;
  try {
    session = await LM.create({
      ...LANGS,
      initialPrompts: input.initialPrompts,
      signal: o.signal,
      monitor: (m: EventTarget) => m.addEventListener('downloadprogress', (e) => o.onStatus?.(`Downloading the browser’s built-in model: ${Math.round(((e as ProgressEvent).loaded ?? 0) * 100)}%`)),
    });
  } catch (err) {
    if (tooLarge(err)) throw new BuiltinTooLarge(lastWindow);
    throw err;
  }
  const window = session.contextWindow ?? session.inputQuota;
  if (window) lastWindow = window;
  try {
    o.onStatus?.('');
    let full = '';
    for await (const chunk of session.promptStreaming(input.prompt, { signal: o.signal })) {
      // Early versions sent the whole text so far each time; current ones send what is new.
      const add = chunk.startsWith(full) && full ? chunk.slice(full.length) : chunk;
      full += add;
      if (add) o.onChunk?.(add);
    }
    return { text: full, window };
  } catch (err) {
    if (tooLarge(err)) throw new BuiltinTooLarge(window);
    throw err;
  } finally {
    session.destroy();
  }
}
