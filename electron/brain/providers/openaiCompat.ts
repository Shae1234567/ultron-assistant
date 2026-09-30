import { LlmError, newId, type ChatRequest, type ChatResult, type ToolCall } from '../types';

/**
 * Any service that speaks the OpenAI Chat Completions API: OpenAI itself, OpenRouter, Groq, DeepSeek, Together,
 * Mistral, xAI, or a local server such as LM Studio. One base URL, one key, one model.
 *
 * Services differ in which optional settings they accept - reasoning models refuse `temperature`, some servers
 * refuse `stream_options` or `response_format`. A 400 naming such a setting is answered by dropping it and asking
 * again, so the operator never has to know which service wants what.
 */

export interface OpenAiTarget {
  baseUrl: string;
  key: string;
  model: string;
}

const IDLE_TIMEOUT_MS = 120_000;
const OPTIONAL = ['temperature', 'reasoning_effort', 'response_format', 'stream_options', 'parallel_tool_calls'] as const;
type Optional = (typeof OPTIONAL)[number];

/** Settings a model refused this session ("model|setting"), so the next call leaves them out from the start. */
const refused = new Set<string>();

export function toOpenAiMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [];
  const schema = typeof req.json === 'object' ? `\n\nReply with ONLY a JSON object matching this JSON schema:\n${JSON.stringify(req.json)}` : req.json ? '\n\nReply with ONLY a JSON object.' : '';
  if (req.system || schema) out.push({ role: 'system', content: `${req.system}${schema}` });
  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push(m.images?.length
        ? { role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } }))] }
        : { role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || (m.toolCalls?.length ? null : ''),
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.callId, content: m.content });
    }
  }
  return out;
}

/** Reasoning models (o-series, gpt-5...) take an effort level; others would refuse it. */
function reasoningModel(model: string): boolean {
  return /(^|\/)(o\d|gpt-5)/i.test(model);
}

export function buildBody(t: OpenAiTarget, req: ChatRequest, drop: Set<string>): Record<string, unknown> {
  const body: Record<string, unknown> = { model: t.model, messages: toOpenAiMessages(req), stream: true };
  const put = (k: Optional, v: unknown) => { if (!drop.has(k) && !refused.has(`${t.model}|${k}`)) body[k] = v; };
  put('stream_options', { include_usage: true });
  if (req.temperature !== undefined && !reasoningModel(t.model)) put('temperature', req.temperature);
  if (req.effort && reasoningModel(t.model)) put('reasoning_effort', req.effort);
  if (req.json) put('response_format', { type: 'json_object' });
  if (req.tools?.length) body.tools = req.tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.parameters } }));
  return body;
}

/** Which optional setting a 400 is about, if any. */
export function refusedSetting(message: string): Optional | null {
  return OPTIONAL.find((k) => message.includes(k)) ?? null;
}

function classify(status: number, message: string, retryAfter: string | null): LlmError {
  if (status === 401 || status === 403) return new LlmError(`The API key was refused (${status}): ${message}`, 'auth');
  if (status === 404 || /model.*(not found|does not exist)|unknown model/i.test(message)) return new LlmError(`Model not available: ${message}`, 'model');
  if (status === 429) {
    const secs = Number(retryAfter);
    const daily = /per day|daily|quota|insufficient_quota|billing/i.test(message);
    return new LlmError(daily ? `The account's limit or credit is used up: ${message}` : `Rate limited: ${message}`, 'rate', Number.isFinite(secs) && secs > 0 && !daily ? secs * 1000 : undefined);
  }
  if (status >= 500) return new LlmError(`The service is overloaded or unavailable (${status}): ${message}`, 'network');
  return new LlmError(`${status}: ${message}`, 'other');
}

export async function openaiChat(t: OpenAiTarget, req: ChatRequest): Promise<ChatResult> {
  const drop = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    try {
      return await once(t, req, drop);
    } catch (e) {
      const setting = e instanceof LlmError && e.kind === 'other' && /^400:/.test(e.message) ? refusedSetting(e.message) : null;
      if (!setting || attempt >= OPTIONAL.length) throw e;
      drop.add(setting);
      refused.add(`${t.model}|${setting}`);
    }
  }
}

async function once(t: OpenAiTarget, req: ChatRequest, drop: Set<string>): Promise<ChatResult> {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  req.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS); };

  let text = '';
  let usage: ChatResult['usage'];
  const partial = new Map<number, { id: string; name: string; args: string }>();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    armIdle();
    const res = await fetch(`${t.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(t.key ? { Authorization: `Bearer ${t.key}` } : {}) },
      body: JSON.stringify(buildBody(t, req, drop)),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '');
      let message = raw.slice(0, 400);
      try { message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? message; } catch { /* not JSON */ }
      throw classify(res.status, message || res.statusText, res.headers.get('retry-after'));
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (line: string) => {
      const l = line.trim();
      if (!l.startsWith('data:')) return;
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j: {
        choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null;
        error?: { message?: string };
      };
      try { j = JSON.parse(data); } catch { return; }
      if (j.error) throw new LlmError(j.error.message ?? 'The service reported an error.', 'other');
      if (j.usage) usage = { input: j.usage.prompt_tokens, output: j.usage.completion_tokens, thinking: j.usage.completion_tokens_details?.reasoning_tokens };
      const delta = j.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        req.onToken?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = partial.get(i) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partial.set(i, cur);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handle(line);
    }
    if (buffer.trim()) handle(buffer);
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      if (req.signal?.aborted) throw new LlmError('cancelled', 'aborted');
      throw new LlmError('The AI service stopped responding.', 'network');
    }
    throw new LlmError(`Could not reach ${t.baseUrl}: ${e instanceof Error ? e.message : String(e)}`, 'network');
  } finally {
    clearTimeout(idle);
    req.signal?.removeEventListener('abort', onOuterAbort);
    if (reader) { try { await reader.cancel(); } catch { /* closed */ } }
  }

  const toolCalls: ToolCall[] = [...partial.entries()].sort((a, b) => a[0] - b[0]).filter(([, c]) => c.name).map(([, c]) => {
    let args: Record<string, unknown> = {};
    try { args = c.args.trim() ? JSON.parse(c.args) as Record<string, unknown> : {}; } catch { args = {}; }
    return { id: c.id || newId('t'), name: c.name, args };
  });
  return { text: text.trim(), toolCalls, provider: 'openai', model: t.model, usage };
}

/** The models a key can use - also how Settings checks the key works. */
export async function openaiModels(baseUrl: string, key: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = raw.slice(0, 300);
    try { message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? message; } catch { /* not JSON */ }
    throw classify(res.status, message || res.statusText, null);
  }
  const data = (await res.json()) as { data?: { id?: string }[] };
  return (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort();
}
