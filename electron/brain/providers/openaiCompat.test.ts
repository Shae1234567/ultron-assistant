import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBody, openaiChat, refusedSetting, toOpenAiMessages } from './openaiCompat';
import type { ChatRequest } from '../types';

const t = { baseUrl: 'https://api.example.com/v1', key: 'k', model: 'example-chat' };

describe('the OpenAI-compatible provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns Ultron\'s conversation into chat messages - tool calls, tool results and images', () => {
    const req: ChatRequest = {
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'what is on screen?', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: 'Paris' } }] },
        { role: 'tool', callId: 'c1', name: 'get_weather', content: '{"temp":20}' },
      ],
      json: true,
    };
    expect(toOpenAiMessages(req)).toEqual([
      { role: 'system', content: 'Be brief.\n\nReply with ONLY a JSON object.' },
      { role: 'user', content: [{ type: 'text', text: 'what is on screen?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":20}' },
    ]);
  });

  it('leaves out settings reasoning models refuse', () => {
    const req: ChatRequest = { system: '', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, effort: 'high' };
    expect(buildBody(t, req, new Set())).toMatchObject({ temperature: 0.7 });
    expect(buildBody(t, req, new Set())).not.toHaveProperty('reasoning_effort');
    const reasoning = buildBody({ ...t, model: 'o4-mini' }, req, new Set());
    expect(reasoning).not.toHaveProperty('temperature');
    expect(reasoning).toMatchObject({ reasoning_effort: 'high' });
    expect(refusedSetting("400: Unsupported parameter: 'temperature' is not supported with this model.")).toBe('temperature');
  });

  it('streams text and tool calls, and drops a setting the service refuses', async () => {
    const bodies: Record<string, unknown>[] = [];
    const sse = (lines: object[]) => new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ('stream_options' in body) return new Response(JSON.stringify({ error: { message: 'Unknown field: stream_options' } }), { status: 400 });
      return sse([
        { choices: [{ delta: { content: 'Checking ' } }] },
        { choices: [{ delta: { content: 'now.', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
      ]);
    }));
    const tokens: string[] = [];
    const res = await openaiChat(t, { system: '', messages: [{ role: 'user', content: 'weather?' }], tools: [{ name: 'get_weather', description: 'x', parameters: { type: 'object' } }], onToken: (x) => { tokens.push(x); } });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('stream_options');
    expect(res).toMatchObject({ text: 'Checking now.', provider: 'openai', toolCalls: [{ id: 'call_1', name: 'get_weather', args: { city: 'Paris' } }], usage: { input: 12, output: 5 } });
    expect(tokens.join('')).toBe('Checking now.');
  });

  it('names a bad key and a rate limit the way the router understands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 })));
    await expect(openaiChat(t, { system: '', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ kind: 'auth' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429, headers: { 'retry-after': '7' } })));
    await expect(openaiChat(t, { system: '', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ kind: 'rate', retryAfterMs: 7000 });
  });
});
