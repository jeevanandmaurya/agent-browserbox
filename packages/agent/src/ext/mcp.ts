import { VERSION } from '../version.js';
import type { KernelCore } from '../host/os.js';
import { clip, type ToolDef } from '../tools/types.js';
import type { JsonSchema } from '../types.js';

/** A remote MCP server (Model Context Protocol, Streamable HTTP transport). */
export interface McpServerConfig {
  name: string;
  url: string;
  enabled: boolean;
  /**
   * 'direct': this browser talks to the server, which must allow cross-origin requests.
   * 'anthropic': Claude's API connects to it server-side (Claude provider only; no CORS needed).
   */
  via: 'direct' | 'anthropic';
}

export const MCP_KEY = 'mcp.servers';
export const mcpTokenName = (server: string) => `mcp.${server}.token`;
const PROTOCOL = '2025-06-18';

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: JsonSchema['properties']; required?: string[] };
}

/** Minimal MCP client: initialize, tools/list, tools/call over HTTP POST with JSON or SSE replies. */
export class McpClient {
  #id = 1;
  #session: string | null = null;
  #ready: Promise<void> | null = null;

  constructor(
    readonly url: string,
    private token: string | null,
  ) {}

  async #post(body: object, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.#ready ? { 'mcp-protocol-version': PROTOCOL } : {}),
          ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`Could not reach ${new URL(this.url).host}. The server is down or does not allow requests from browsers (CORS).`);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`${new URL(this.url).host} rejected the credentials (HTTP ${res.status}). Check the token.`);
    if (!res.ok) throw new Error(`${new URL(this.url).host} answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res;
  }

  async #rpc<T>(method: string, params?: object, signal?: AbortSignal): Promise<T> {
    const id = this.#id++;
    const res = await this.#post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, signal);
    this.#session = res.headers.get('mcp-session-id') ?? this.#session;
    let reply: RpcResponse | undefined;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // The reply arrives as server-sent events; ours is the message carrying our id.
      const reader = res.body!.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
      let buf = '';
      outer: for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let end: number;
        while ((end = buf.search(/\r?\n\r?\n/)) >= 0) {
          const event = buf.slice(0, end);
          buf = buf.slice(end).replace(/^\r?\n\r?\n/, '');
          const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          const msg = JSON.parse(data) as RpcResponse;
          if (msg.id === id) {
            reply = msg;
            void reader.cancel();
            break outer;
          }
        }
      }
    } else reply = (await res.json()) as RpcResponse;
    if (!reply) throw new Error(`no reply to ${method}`);
    if (reply.error) throw new Error(`${method} failed: ${reply.error.message}`);
    return reply.result as T;
  }

  init(signal?: AbortSignal): Promise<void> {
    return (this.#ready ??= (async () => {
      await this.#rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agent-browserbox', version: VERSION } }, signal);
      await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
    })().catch((err) => {
      this.#ready = null;
      throw err;
    }));
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.init(signal);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#rpc<{ tools: McpTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : undefined, signal);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  async callTool(name: string, args: object, signal?: AbortSignal): Promise<string> {
    await this.init(signal);
    const r = await this.#rpc<{ content?: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean }>('tools/call', { name, arguments: args }, signal);
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`)).join('\n');
    if (r.isError) throw new Error(text || 'the tool reported an error');
    return text || '(no output)';
  }
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Connects to the configured MCP servers and exposes their tools to the agent. */
export class McpHub {
  #clients = new Map<string, { key: string; client: McpClient; tools: Promise<ToolDef[]> }>();
  /** Last connection error per server, for the settings screen. */
  readonly errors = new Map<string, string>();

  constructor(private os: KernelCore) {}

  servers(): McpServerConfig[] {
    return this.os.settings.get<McpServerConfig[]>(MCP_KEY, []);
  }

  async #client(s: McpServerConfig): Promise<{ client: McpClient; fresh: boolean; key: string }> {
    const token = await this.os.secrets.get(mcpTokenName(s.name));
    const key = `${s.url}\n${token ?? ''}`;
    const have = this.#clients.get(s.name);
    return have?.key === key ? { client: have.client, fresh: false, key } : { client: new McpClient(s.url, token), fresh: true, key };
  }

  /** Tools from every enabled direct server. A server that fails is skipped and reported once. */
  async tools(): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    for (const s of this.servers().filter((x) => x.enabled && x.via === 'direct')) {
      const { client, fresh, key } = await this.#client(s);
      if (fresh) {
        const tools = client.listTools().then((list) =>
          list.map(
            (t): ToolDef => ({
              name: `mcp__${safe(s.name)}__${safe(t.name)}`.slice(0, 64),
              description: `[${s.name} connector] ${t.description ?? t.name}`,
              input_schema: { type: 'object', properties: t.inputSchema?.properties ?? {}, required: t.inputSchema?.required ?? [] },
              cap: () => 'net',
              describe: (input) => `${s.name}: ${t.name} ${JSON.stringify(input).slice(0, 300)}`,
              run: async (input, tc) => clip(await client.callTool(t.name, input, tc.signal)),
            }),
          ),
        );
        this.#clients.set(s.name, { key, client, tools });
      }
      try {
        out.push(...(await this.#clients.get(s.name)!.tools));
        this.errors.delete(s.name);
      } catch (err) {
        const message = (err as Error).message;
        if (this.errors.get(s.name) !== message) this.os.notify({ title: `Connector “${s.name}” is unavailable`, body: message, level: 'warn' });
        this.errors.set(s.name, message);
        this.#clients.delete(s.name); // retry on the next message
      }
    }
    return out;
  }

  /** Connects from scratch and lists the server's tools (the "Test" button). */
  async probe(name: string): Promise<Array<{ name: string; description: string }>> {
    const s = this.servers().find((x) => x.name === name);
    if (!s) throw new Error(`no such connector: ${name}`);
    this.#clients.delete(name);
    const { client } = await this.#client(s);
    return (await client.listTools()).map((t) => ({ name: t.name, description: t.description ?? '' }));
  }

  /** Servers Claude's API should connect to itself. */
  async relayed(): Promise<Array<{ name: string; url: string; token: string | null }>> {
    return Promise.all(this.servers().filter((s) => s.enabled && s.via === 'anthropic').map(async (s) => ({ name: safe(s.name), url: s.url, token: await this.os.secrets.get(mcpTokenName(s.name)) })));
  }
}
