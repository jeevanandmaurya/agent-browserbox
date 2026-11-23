import { describe, expect, it } from 'vitest';
import { apiKeyFor, DEFAULT_CONFIG, describeModel, hasServerWebTools, migrate, protocolOf, SECRET } from '../packages/agent/src/config';

describe('model sources', () => {
  it('picks the protocol from the address', () => {
    expect(protocolOf('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(protocolOf('https://api.openai.com/v1')).toBe('openai');
    expect(protocolOf('https://openrouter.ai/api/v1')).toBe('openai');
  });

  it('uses server-side web tools only on Anthropic’s API', () => {
    expect(hasServerWebTools({ ...DEFAULT_CONFIG, provider: 'api', apiBaseUrl: 'https://api.anthropic.com/v1' })).toBe(true);
    expect(hasServerWebTools({ ...DEFAULT_CONFIG, provider: 'api', apiBaseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(hasServerWebTools({ ...DEFAULT_CONFIG, provider: 'local' })).toBe(false);
  });

  it('describes the model with its host', () => {
    expect(describeModel({ ...DEFAULT_CONFIG, provider: 'api', apiBaseUrl: 'https://openrouter.ai/api/v1', apiModel: 'x/y' })).toBe('x/y @ openrouter.ai');
  });
});

describe('older settings', () => {
  it('moves Claude settings to the API source', () => {
    const cfg = migrate({ provider: 'anthropic', anthropicModel: 'claude-sonnet-5-5', effort: 'high', webSearch: true });
    expect(cfg).toMatchObject({ provider: 'api', apiBaseUrl: 'https://api.anthropic.com/v1', apiModel: 'claude-sonnet-5-5' });
    expect(cfg).not.toHaveProperty('effort');
    expect(cfg).not.toHaveProperty('anthropicModel');
  });

  it('moves an OpenAI-compatible API to the API source', () => {
    expect(migrate({ provider: 'openai', openaiBaseUrl: 'https://api.groq.com/openai/v1', openaiModel: 'llama', localBaseUrl: 'http://localhost:11434/v1' })).toMatchObject({ provider: 'api', apiBaseUrl: 'https://api.groq.com/openai/v1', apiModel: 'llama' });
  });

  it('moves a very old local server and the in-browser model', () => {
    expect(migrate({ provider: 'openai', openaiBaseUrl: 'http://localhost:1234/v1', openaiModel: 'q' })).toMatchObject({ provider: 'local', localBaseUrl: 'http://localhost:1234/v1', localModel: 'q' });
    expect(migrate({ provider: 'webllm', webllmModel: 'SmolLM2' })).toMatchObject({ provider: 'webgpu', webgpuModel: 'SmolLM2' });
  });

  it('keeps Claude in the API slot when another source is active', () => {
    expect(migrate({ provider: 'local', localModel: 'q', anthropicModel: 'claude-haiku-5-5' })).toMatchObject({ provider: 'local', apiModel: 'claude-haiku-5-5' });
  });

  it('keeps current settings as they are', () => {
    const now = { ...DEFAULT_CONFIG, provider: 'api' as const, apiBaseUrl: 'https://api.openai.com/v1', apiModel: 'gpt' };
    expect(migrate({ ...now })).toEqual(now);
    expect(migrate({ provider: 'nonsense' }).provider).toBe(DEFAULT_CONFIG.provider);
  });

  it('keeps API keys per host and moves old keys across', async () => {
    const store = new Map<string, string>([['anthropic.apiKey', 'sk-ant-1'], ['openai.apiKey', 'sk-2']]);
    const secrets = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v) };
    expect(await apiKeyFor(secrets, 'https://api.anthropic.com/v1')).toBe('sk-ant-1');
    expect(store.get(SECRET.api('https://api.anthropic.com/v1'))).toBe('sk-ant-1');
    expect(await apiKeyFor(secrets, 'https://openrouter.ai/api/v1')).toBe('sk-2');
    store.set(SECRET.api('https://api.groq.com/openai/v1'), 'gsk');
    expect(await apiKeyFor(secrets, 'https://api.groq.com/openai/v1')).toBe('gsk');
  });
});
