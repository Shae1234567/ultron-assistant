import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError, type ChatRequest } from './types';

/*
 * Deep thinking: the hardest steps go to Google's strongest model (Gemini
 * Pro) with full reasoning. Many free keys don't include Pro at all ("limit:
 * 0"), and its per-minute allowance is small - either way the same request
 * must still be answered, by Flash, without waiting.
 */

const calls: { model: string; effort?: string }[] = [];
let mode = 'deep';
let proAnswer: 'ok' | 'not-in-plan' | 'per-minute' = 'ok';

vi.mock('../store', () => ({
  getSettings: () => ({ brain: 'auto', thinking: mode, gemini: { model: '' }, ollama: { host: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 8192 } }),
  saveSettings: () => {},
}));
vi.mock('../secrets', () => ({ getSecret: (name: string) => (name === 'GEMINI_API_KEY' ? 'test-key' : '') }));
vi.mock('../ollama', () => ({ status: async () => ({ running: false, modelInstalled: false }) }));
vi.mock('./providers/ollama', () => ({ ollamaChat: async () => { throw new Error('local model should not be needed'); } }));
vi.mock('./providers/gemini', () => ({
  listGeminiModels: async () => ({
    checkedAt: Date.now(), models: [], best: 'gemini-3.8-flash', fallback: 'gemini-3.7-flash', live: null,
    ranked: ['gemini-3.8-flash', 'gemini-3.7-flash'], pro: ['gemini-3.1-pro-preview'],
  }),
  geminiChat: async (_key: string, model: string, req: ChatRequest) => {
    calls.push({ model, effort: req.effort });
    if (/pro/.test(model) && proAnswer === 'not-in-plan') throw new LlmError('This Gemini model is not included in the free tier.', 'rate');
    if (/pro/.test(model) && proAnswer === 'per-minute') throw new LlmError('Gemini rate limit reached.', 'rate', 40_000);
    return { text: `answered by ${model}`, toolCalls: [], provider: 'gemini', model };
  },
  geminiGrounded: async () => ({ answer: '', sources: [], queries: [] }),
}));

const { chat, tuned } = await import('./llm');
const ask = (extra: Partial<ChatRequest> = {}) => chat({ system: '', messages: [{ role: 'user', content: 'a hard problem' }], ...extra });

beforeEach(() => {
  calls.length = 0;
  mode = 'deep';
});

describe('deep thinking', () => {
  it('sends the hardest steps to Gemini Pro with full reasoning', async () => {
    proAnswer = 'ok';
    const res = await ask({ deep: true, effort: 'high' });
    expect(res.text).toBe('answered by gemini-3.1-pro-preview');
    expect(calls).toEqual([{ model: 'gemini-3.1-pro-preview', effort: 'high' }]);
  });

  it('keeps ordinary calls on Flash', async () => {
    await ask({ effort: 'high' });
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.8-flash']);
  });

  it('answers with Flash straight away when Pro is at its per-minute limit - and tries Pro again next time', async () => {
    proAnswer = 'per-minute';
    const notices: string[] = [];
    const res = await ask({ deep: true, effort: 'high', onNotice: (t) => { notices.push(t); } });
    expect(res.text).toBe('answered by gemini-3.8-flash');
    expect(notices[0]).toMatch(/per-minute limit - switching to gemini-3.8-flash/);
    calls.length = 0;
    await ask({ deep: true });
    expect(calls[0].model).toBe('gemini-3.1-pro-preview');
  });

  it('stops asking for Pro once Google says the free plan does not include it', async () => {
    proAnswer = 'not-in-plan';
    const notices: string[] = [];
    const res = await ask({ deep: true, effort: 'high', onNotice: (t) => { notices.push(t); } });
    expect(res.text).toBe('answered by gemini-3.8-flash');
    expect(notices[0]).toMatch(/gemini-3.1-pro-preview is not part of your free Gemini plan/);
    calls.length = 0;
    await ask({ deep: true, effort: 'high' });
    expect(calls).toEqual([{ model: 'gemini-3.8-flash', effort: 'high' }]);
  });
});

describe('the Thinking setting', () => {
  it('Deep leaves each step\'s request as it is', () => {
    const req: ChatRequest = { system: '', messages: [], deep: true, effort: 'high' };
    expect(tuned(req, 'deep')).toEqual(req);
    expect(tuned(req, undefined as never)).toEqual(req);
  });

  it('Balanced keeps full reasoning but never the slower Pro model', () => {
    expect(tuned({ system: '', messages: [], deep: true, effort: 'high' }, 'balanced')).toMatchObject({ deep: false, effort: 'high' });
  });

  it('Fast caps reasoning for quicker replies', () => {
    expect(tuned({ system: '', messages: [], deep: true, effort: 'high' }, 'fast')).toMatchObject({ deep: false, effort: 'medium', think: false });
    expect(tuned({ system: '', messages: [], effort: 'low' }, 'fast').effort).toBe('low');
  });

  it('is applied to every call', async () => {
    mode = 'fast';
    await ask({ deep: true, effort: 'high' });
    expect(calls).toEqual([{ model: 'gemini-3.8-flash', effort: 'medium' }]);
  });
});
