/** Provider-neutral conversation model. Each provider adapter maps to and from its wire format. */

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; /** Set when the model produced unparseable arguments. */ invalid?: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /** Something the provider did on its side (e.g. a web search). Display only. */
  | { type: 'server_note'; text: string };

/** Where the context window is going. Counts are estimates except `used` when `reported` is true. */
export interface ContextReport {
  window: number;
  /** Tokens in the context as of the last model call. */
  used: number;
  /** True when `used` was reported by the model rather than estimated. */
  reported: boolean;
  parts: { system: number; tools: number; user: number; assistant: number; toolCalls: number; toolResults: number };
  messages: number;
  compactions: number;
  /** Fraction of the window at which the conversation is compacted automatically (0 = off). */
  autoCompactAt: number;
}

export interface Msg {
  role: 'user' | 'assistant';
  content: Block[];
  /**
   * The provider's native content for an assistant turn. Echoed back verbatim
   * to the same provider so signed blocks (thinking, server tool results) stay valid.
   */
  raw?: { provider: string; content: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface TurnRequest {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText(delta: string): void;
  onThinking(delta: string): void;
  onStatus(text: string): void;
}

export interface TurnResult {
  content: Block[];
  raw?: Msg['raw'];
  /** `pause` = the provider wants the same conversation re-sent to continue a server-side turn. */
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause';
  usage: Usage;
  model: string;
}

export interface Provider {
  readonly id: string;
  /** Rough context budget in tokens; the loop elides old tool output beyond it. 0 = provider manages it. */
  readonly contextBudget: number;
  /** Size of the model's context window in tokens. */
  readonly contextWindow: number;
  turn(req: TurnRequest): Promise<TurnResult>;
}

/** An error whose message is safe and useful to show to the user as-is. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
