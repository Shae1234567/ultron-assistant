import { describe, expect, it } from 'vitest';
import { echoable, fromMessage, takesEffort, takesFallback, toClaudeMessages } from './anthropic';

describe('the Claude provider', () => {
  it('sends all tool results of a turn back in one user message, and replays Claude\'s own reply unchanged', () => {
    const native = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'a', input: {} }, { type: 'tool_use', id: 't2', name: 'b', input: {} }];
    const out = toClaudeMessages([
      { role: 'user', content: 'do two things' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: {} }], native, nativeProvider: 'anthropic' },
      { role: 'tool', callId: 't1', name: 'a', content: 'one' },
      { role: 'tool', callId: 't2', name: 'b', content: 'two' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'do two things' },
      { role: 'assistant', content: native },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'one' }, { type: 'tool_result', tool_use_id: 't2', content: 'two' }] },
    ]);
  });

  it('carries tool calls made by another provider, and always opens with the operator', () => {
    const out = toClaudeMessages([
      { role: 'assistant', content: 'Earlier reply.' },
      { role: 'user', content: 'go on' },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'g1', name: 'web_search', args: { q: 'x' } }], nativeProvider: 'gemini', native: [{ parts: [] }] },
      { role: 'tool', callId: 'g1', name: 'web_search', content: 'found' },
    ]);
    expect(out[0]).toEqual({ role: 'user', content: '(earlier conversation)' });
    expect(out[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'g1', name: 'web_search', input: { q: 'x' } }] });
  });

  it('after a refusal fallback, echoes back only what may be echoed', () => {
    const content = [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Part one. ' },
      { type: 'tool_use', id: 'x', name: 'a', input: {} },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
      { type: 'text', text: 'Part two.' },
    ];
    expect(echoable(content).map((b) => b.type)).toEqual(['text', 'fallback', 'text']);
  });

  it('never runs the tools of a turn that was cut off, and says when Claude declined', () => {
    expect(() => fromMessage('m', { content: [{ type: 'tool_use', id: 't', name: 'a', input: {} }], stop_reason: 'max_tokens' })).toThrow(/ran out of room/);
    const r = fromMessage('m', { content: [{ type: 'text', text: '' }], stop_reason: 'refusal', stop_details: { category: 'cyber' } });
    expect(r).toMatchObject({ toolCalls: [], text: expect.stringMatching(/declined this request: cyber/) });
    const ok = fromMessage('m', { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't', name: 'a', input: { q: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 3 } });
    expect(ok).toMatchObject({ text: 'On it.', toolCalls: [{ id: 't', name: 'a', args: { q: 1 } }], provider: 'anthropic', usage: { input: 10, output: 3 } });
  });

  it('asks for effort and the refusal fallback only where the model takes them', () => {
    expect(takesEffort('claude-opus-5-5')).toBe(true);
    expect(takesEffort('claude-haiku-4-5')).toBe(false);
    expect(takesFallback('claude-sonnet-5-5')).toBe(true);
    expect(takesFallback('claude-haiku-4-5')).toBe(false);
  });
});
