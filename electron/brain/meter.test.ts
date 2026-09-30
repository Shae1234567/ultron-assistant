import { describe, expect, it } from 'vitest';
import { currentMeter, describeUsage, newMeter, overBudget, record, withMeter } from './meter';

describe('the per-request meter', () => {
  it('counts every model call made inside a request, however deep', async () => {
    const m = newMeter({ maxCalls: 60, maxTokens: 600_000, maxMs: 600_000 }, 0);
    await withMeter(m, async () => {
      record('gemini-3.8-flash', { input: 1200, output: 300, thinking: 500 });
      await Promise.all([1, 2].map(async () => {
        await Promise.resolve();
        record('gemini-3.1-pro', { input: 100, output: 50 });
      }));
    });
    expect(m.usage).toMatchObject({ calls: 3, inputTokens: 1400, outputTokens: 400, thinkingTokens: 500, byModel: { 'gemini-3.8-flash': 1, 'gemini-3.1-pro': 2 } });
    expect(currentMeter()).toBeUndefined();
    expect(describeUsage(m, 52_000)).toBe('3 model calls · 2k tokens · 52 s');
  });

  it('says which limit was reached, and stays stopped', () => {
    const m = newMeter({ maxCalls: 2, maxTokens: 600_000, maxMs: 600_000 }, 0);
    record('x', {}, m);
    expect(overBudget(m, 1000)).toBeNull();
    record('x', {}, m);
    expect(overBudget(m, 1000)).toBe('the limit of 2 model calls for one request');
    const t = newMeter({ maxCalls: 60, maxTokens: 1000, maxMs: 120_000 }, 0);
    expect(overBudget(t, 130_000)).toBe('the 2-minute time limit');
    expect(overBudget(undefined)).toBeNull();
  });
});
