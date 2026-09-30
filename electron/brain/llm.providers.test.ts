import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from './types';

/*
 * Choosing the AI: Gemini, Claude, an OpenAI-compatible service, or the local model - and falling back
 * from a failing cloud provider to the local one.
 */

const settings = {
  brain: 'auto' as string,
  thinking: 'deep',
  gemini: { model: '' },
  openai: { baseUrl: 'https://api.example.com/v1', model: 'example-model' },
  anthropic: { model: 'claude-sonnet-5-5' },
  ollama: { host: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 8192 },
};
const keys: Record<string, string> = {};
let ollamaUp = false;
const answered: string[] = [];
let claudeFails: LlmError | null = null;

vi.mock('../store', () => ({ getSettings: () => settings, saveSettings: () => {} }));
vi.mock('../secrets', () => ({ getSecret: (name: string) => keys[name] ?? '' }));
vi.mock('../ollama', () => ({ status: async () => ({ running: ollamaUp, modelInstalled: ollamaUp, activeModel: 'qwen3.5:4b', models: [] }) }));
vi.mock('./providers/ollama', () => ({ ollamaChat: async () => { answered.push('ollama'); return { text: 'local', toolCalls: [], provider: 'ollama', model: 'qwen3.5:4b' }; } }));
vi.mock('./providers/gemini', () => ({
  listGeminiModels: async () => ({ checkedAt: Date.now(), models: [], best: 'gemini-3.8-flash', fallback: null, live: null, ranked: ['gemini-3.8-flash'] }),
  geminiChat: async () => { answered.push('gemini'); return { text: 'gemini', toolCalls: [], provider: 'gemini', model: 'gemini-3.8-flash' }; },
  geminiGrounded: async () => ({}),
}));
vi.mock('./providers/openaiCompat', () => ({
  openaiChat: async (t: { model: string }) => { answered.push(`openai:${t.model}`); return { text: 'openai', toolCalls: [], provider: 'openai', model: t.model }; },
  openaiModels: async () => ['example-model', 'other-model'],
}));
vi.mock('./providers/anthropic', () => ({
  claudeChat: async (t: { model: string }) => {
    answered.push(`anthropic:${t.model}`);
    if (claudeFails) throw claudeFails;
    return { text: 'claude', toolCalls: [], provider: 'anthropic', model: t.model };
  },
  claudeModels: async () => { if (keys.ANTHROPIC_API_KEY === 'bad') throw new LlmError('Anthropic refused the API key', 'auth'); return ['claude-opus-5-5', 'claude-sonnet-5-5']; },
}));

const { chat, brainStatus, checkCloud } = await import('./llm');
const ask = () => chat({ system: '', messages: [{ role: 'user', content: 'hi' }] });

beforeEach(async () => {
  for (const k of Object.keys(keys)) delete keys[k];
  answered.length = 0;
  ollamaUp = false;
  claudeFails = null;
  settings.brain = 'auto';
  await brainStatus(); // resets the router's 15-second "is Ollama up" cache for each test
});

describe('choosing the AI', () => {
  it('uses the provider the operator picked', async () => {
    keys.ANTHROPIC_API_KEY = 'k';
    keys.OPENAI_API_KEY = 'k';
    settings.brain = 'openai';
    await ask();
    settings.brain = 'anthropic';
    await ask();
    expect(answered).toEqual(['openai:example-model', 'anthropic:claude-sonnet-5-5']);
  });

  it('Automatic takes the first cloud provider with a key - Gemini, then Claude, then OpenAI-compatible', async () => {
    keys.OPENAI_API_KEY = 'k';
    await ask();
    keys.ANTHROPIC_API_KEY = 'k';
    await ask();
    expect(answered).toEqual(['openai:example-model', 'anthropic:claude-sonnet-5-5']);
    const st = await brainStatus();
    expect(st).toMatchObject({ active: 'anthropic', label: 'CLAUDE ONLINE', model: 'claude-sonnet-5-5' });
  });

  it('falls back to the local model when the chosen cloud provider fails', async () => {
    keys.ANTHROPIC_API_KEY = 'k';
    settings.brain = 'anthropic';
    ollamaUp = true;
    await brainStatus(); // the router caches whether Ollama is up for 15 s - this refreshes it, as startup does
    claudeFails = new LlmError('Anthropic is overloaded or unavailable (529)', 'network');
    const notices: string[] = [];
    const res = await chat({ system: '', messages: [{ role: 'user', content: 'hi' }], onNotice: (t) => { notices.push(t); } });
    expect(res.provider).toBe('ollama');
    expect(notices[0]).toMatch(/Claude failed .*the local model is taking over/);
  });

  it('says plainly when no AI is set up at all', async () => {
    await expect(ask()).rejects.toThrow(/No AI is set up yet/);
  });

  it('needs no key for an OpenAI-compatible server on this PC (LM Studio)', async () => {
    settings.openai.baseUrl = 'http://localhost:1234/v1';
    settings.brain = 'openai';
    await ask();
    expect(answered).toEqual(['openai:example-model']);
    settings.openai.baseUrl = 'https://api.example.com/v1';
  });

  it('checks a key by listing its models, and stops using a refused one', async () => {
    keys.ANTHROPIC_API_KEY = 'k';
    expect(await checkCloud('anthropic')).toMatchObject({ configured: true, valid: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] });
    keys.ANTHROPIC_API_KEY = 'bad';
    expect(await checkCloud('anthropic')).toMatchObject({ valid: false, error: expect.stringMatching(/refused/) });
    settings.brain = 'anthropic';
    await expect(ask()).rejects.toThrow(/No AI is set up yet/);
  });
});
