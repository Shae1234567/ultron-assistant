import { describe, expect, it } from 'vitest';
import { rankGeminiModels } from './gemini';

const m = (name: string, actions = ['generateContent']) => ({ name, displayName: name, actions });

describe('rankGeminiModels', () => {
  it('picks the newest Flash and skips specialised models', () => {
    const { best } = rankGeminiModels([
      m('gemini-2.5-flash'),
      m('gemini-2.5-pro'),
      m('gemini-3-flash'),
      m('gemini-3-flash-preview-tts'),
      m('gemini-3-pro-image-preview'),
      m('gemini-embedding-001', ['embedContent']),
      m('gemini-3-flash-lite'),
    ]);
    expect(best).toBe('gemini-3-flash');
  });

  it('prefers a stable model over a preview at the same version', () => {
    expect(rankGeminiModels([m('gemini-3-flash-preview'), m('gemini-3-flash')]).best).toBe('gemini-3-flash');
  });

  it('falls back to Pro when no Flash exists', () => {
    expect(rankGeminiModels([m('gemini-2.5-pro')]).best).toBe('gemini-2.5-pro');
  });

  it('finds a Live model by its bidi action', () => {
    const { live } = rankGeminiModels([
      m('gemini-2.5-flash'),
      m('gemini-2.5-flash-native-audio-preview', ['bidiGenerateContent']),
    ]);
    expect(live).toBe('gemini-2.5-flash-native-audio-preview');
  });

  it('returns null with nothing usable', () => {
    expect(rankGeminiModels([m('gemini-embedding-001', ['embedContent'])])).toEqual({ best: null, fallback: null, live: null, ranked: [] });
  });

  it('picks a different model family as the overload fallback', () => {
    const r = rankGeminiModels([m('gemini-3.8-flash'), m('gemini-3.8-flash-preview-09-2026'), m('gemini-3.5-flash'), m('gemini-2.5-pro')]);
    expect(r.best).toBe('gemini-3.8-flash');
    expect(r.fallback).toBe('gemini-3.5-flash');
  });
});

describe('toContents', () => {
  it('passes tool calls from another provider to Gemini as text, not signature-less function calls', async () => {
    const { toContents } = await import('./gemini');
    const contents = toContents([
      { role: 'user', content: 'find it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'web_search', args: { query: 'x' } }], nativeProvider: 'ollama' },
      { role: 'tool', callId: 't1', name: 'web_search', content: '{"results":[]}' },
    ]);
    expect(contents).toHaveLength(3);
    expect(contents[1].parts?.[0]).toEqual({ text: '[Called web_search {"query":"x"}]' });
    expect(contents[1].parts?.some((p) => 'functionCall' in p)).toBe(false);
    expect(contents[2].parts?.[0].text).toContain('[Result of web_search]');
  });

  it('keeps native Gemini turns intact so thought signatures survive', async () => {
    const { toContents } = await import('./gemini');
    const native = { role: 'model', parts: [{ functionCall: { name: 'web_search', args: {} }, thoughtSignature: 'sig' }] };
    const contents = toContents([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'g:abc', name: 'web_search', args: {} }], native, nativeProvider: 'gemini' },
      { role: 'tool', callId: 'g:abc', name: 'web_search', content: '{"ok":true}' },
    ]);
    expect(contents[1]).toBe(native);
    expect(contents[2].parts?.[0].functionResponse?.name).toBe('web_search');
  });
});

describe('proModels (the strongest reasoning models, for deep thinking)', async () => {
  const { proModels } = await import('./gemini');
  const m = (name: string) => ({ name, displayName: name, actions: ['generateContent'] });
  it('ranks the newest Pro first and skips Flash, previews of older versions and special-purpose models', () => {
    expect(proModels([
      m('gemini-2.5-pro'), m('gemini-3.1-pro-preview'), m('gemini-3.1-pro-preview-customtools'), m('gemini-3.8-flash'),
      m('gemini-2.5-pro-preview-tts'),
    ])).toEqual(['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3.1-pro-preview-customtools']);
  });
});
