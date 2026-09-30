import { describe, expect, it, vi } from 'vitest';
import { LlmError } from './types';

/*
 * 26 Sep 2026: Settings had Gemini pinned to gemini-2.5-flash, which Google
 * then answered with 404 "no longer available to new users" - so every
 * request fell to the small local model. A retired model must be skipped and
 * the same request answered by the next Gemini model.
 */

const calls: string[] = [];
const dailyUsedUp = new Set<string>();
const busy = new Set<string>();

const pinned = { model: 'gemini-2.5-flash' };
const saved: unknown[] = [];
vi.mock('../store', () => ({
  getSettings: () => ({ brain: 'auto', thinking: 'deep', gemini: { ...pinned }, ollama: { host: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 8192 } }),
  saveSettings: (patch: { gemini?: { model: string } }) => { saved.push(patch); if (patch.gemini) pinned.model = patch.gemini.model; },
}));
vi.mock('../secrets', () => ({ getSecret: (name: string) => (name === 'GEMINI_API_KEY' ? 'test-key' : '') }));
vi.mock('../ollama', () => ({ status: async () => ({ running: false, modelInstalled: false }) }));
vi.mock('./providers/ollama', () => ({ ollamaChat: async () => { throw new Error('local model should not be needed'); } }));
vi.mock('./providers/gemini', () => ({
  listGeminiModels: async () => ({ checkedAt: Date.now(), models: [], best: 'gemini-3.8-flash', fallback: 'gemini-3.8-pro', live: null, ranked: ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.8-flash-lite'] }),
  geminiChat: async (_key: string, model: string) => {
    calls.push(model);
    if (model === 'gemini-2.5-flash') throw new LlmError('Gemini model not found: This model models/gemini-2.5-flash is no longer available to new users.', 'model');
    if (busy.has(model)) throw new LlmError('Gemini server error (503).', 'network');
    if (dailyUsedUp.has(model)) throw new LlmError("Gemini's free daily limit is used up (it resets at midnight Pacific time).", 'rate', 3_600_000);
    return { text: `answered by ${model}`, toolCalls: [], provider: 'gemini', model };
  },
}));

const { chat } = await import('./llm');

describe('a retired Gemini model', () => {
  it('is skipped and the same request is answered by the next Gemini model', async () => {
    const notices: string[] = [];
    const res = await chat({ system: '', messages: [{ role: 'user', content: 'hi' }], onNotice: (t) => { notices.push(t); } });
    expect(res.text).toBe('answered by gemini-3.8-flash');
    expect(notices[0]).toMatch(/gemini-2.5-flash is no longer available.*Automatic.*switching to gemini-3.8-flash/);
    // Settings goes back to Automatic for good, so the next session doesn't waste a call on it either.
    expect(saved).toEqual([{ gemini: { model: '' } }]);
    // Never tried again after that.
    calls.length = 0;
    await chat({ system: '', messages: [{ role: 'user', content: 'again' }] });
    expect(calls).toEqual(['gemini-3.8-flash']);
  });
});

describe('a used-up daily limit', () => {
  it('moves to the next Gemini model, which has its own limit, instead of the local model', async () => {
    dailyUsedUp.add('gemini-3.8-flash');
    const notices: string[] = [];
    const res = await chat({ system: '', messages: [{ role: 'user', content: 'hi' }], onNotice: (t) => { notices.push(t); } });
    expect(res.text).toBe('answered by gemini-3.8-pro');
    expect(notices.some((n) => /gemini-3.8-flash used up its free daily limit - switching to gemini-3.8-pro/.test(n))).toBe(true);
  });
});

describe('nextPacificMidnight', async () => {
  const { nextPacificMidnight } = await import('./llm');
  it('is the coming midnight in California (12:40 PDT -> 07:00 UTC next day)', () => {
    expect(new Date(nextPacificMidnight(Date.parse('2026-09-26T19:40:00Z'))).toISOString()).toBe('2026-09-27T07:00:00.000Z');
    expect(new Date(nextPacificMidnight(Date.parse('2026-12-01T12:00:00Z'))).toISOString()).toBe('2026-12-02T08:00:00.000Z');
  });
});

describe('several problems in one request', () => {
  it('moves through retired, used-up and busy models before the local model (the live run of 26 Sep 2026)', async () => {
    // 2.5-flash is retired (first test), 3.8-flash is used up (second test); now 3.8-pro is busy too.
    busy.add('gemini-3.8-pro');
    const notices: string[] = [];
    const res = await chat({ system: '', messages: [{ role: 'user', content: 'hi' }], onNotice: (t) => { notices.push(t); } });
    expect(res.text).toBe('answered by gemini-3.8-flash-lite');
    expect(notices.some((n) => /gemini-3.8-pro is overloaded - switching to gemini-3.8-flash-lite/.test(n))).toBe(true);
  });
});
