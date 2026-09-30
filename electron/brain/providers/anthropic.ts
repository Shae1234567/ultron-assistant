import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type ChatRequest, type ChatResult, type LlmMessage, type ToolCall } from '../types';

/**
 * Claude, through Anthropic's official SDK (Messages API, streamed).
 *
 * What the current models need (Anthropic's API reference, Sep 2026):
 *  - no `temperature` (Opus 5.5 and Sonnet 5.5 reject non-default sampling) and no `thinking` setting - thinking is
 *    adaptive by default and cannot be disabled on Opus 5.5; depth is `output_config.effort`;
 *  - thinking blocks are passed back UNCHANGED on the next turn of a tool loop - so each Claude reply's content is
 *    kept as the message's `native` and replayed as it came;
 *  - all tool results of one turn go back in ONE user message;
 *  - a turn cut off at max_tokens, or declined (`refusal`), never runs its tools;
 *  - `fallbacks: "default"` lets Anthropic re-run a declined request on another model; after such a fallback, the
 *    thinking/tool_use blocks before the last `fallback` block are not echoed back.
 */

type Block = { type: string; [key: string]: unknown };

/** Models that take `output_config.effort` (Haiku 4.5, Sonnet 4.5 and older 3.x models do not). */
export function takesEffort(model: string): boolean {
  return !/haiku|sonnet-4-5|claude-3/i.test(model);
}

/** Models where Anthropic recommends the server-side refusal fallback. */
export function takesFallback(model: string): boolean {
  return /claude-(opus-5|sonnet-5-5|fable-5-1)/i.test(model);
}

/** A Claude reply's content as it may be echoed back: after a fallback, drop model-internal blocks before it. */
export function echoable(content: Block[]): Block[] {
  let last = -1;
  content.forEach((b, i) => { if (b.type === 'fallback') last = i; });
  if (last < 0) return content;
  const internal = new Set(['thinking', 'redacted_thinking', 'tool_use']);
  return content.filter((b, i) => i >= last || !internal.has(b.type) && ['text', 'fallback'].includes(b.type));
}

export function toClaudeMessages(messages: LlmMessage[]): { role: 'user' | 'assistant'; content: string | Block[] }[] {
  const out: { role: 'user' | 'assistant'; content: string | Block[] }[] = [];
  let results: Block[] = [];
  const flush = () => {
    if (results.length) out.push({ role: 'user', content: results });
    results = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      results.push({ type: 'tool_result', tool_use_id: m.callId, content: m.content || '(empty)' });
      continue;
    }
    flush();
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.images?.length
          ? [...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })), { type: 'text', text: m.content || '(image)' }]
          : m.content || '(empty)',
      });
    } else if (m.nativeProvider === 'anthropic' && Array.isArray(m.native) && m.native.length) {
      out.push({ role: 'assistant', content: m.native as Block[] });
    } else {
      const blocks: Block[] = [];
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  }
  flush();
  // The conversation must open with the operator.
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(earlier conversation)' });
  return out;
}

function systemText(req: ChatRequest): string {
  const json = typeof req.json === 'object'
    ? `\n\nReply with ONLY a JSON object matching this JSON schema, nothing else:\n${JSON.stringify(req.json)}`
    : req.json ? '\n\nReply with ONLY a JSON object, nothing else.' : '';
  return `${req.system}${json}`;
}

function toLlmError(e: unknown, signal?: AbortSignal): LlmError {
  if (e instanceof LlmError) return e;
  if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) return new LlmError('cancelled', 'aborted');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new LlmError(`Anthropic refused the API key: ${e.message}`, 'auth');
  if (e instanceof Anthropic.NotFoundError) return new LlmError(`That Claude model is not available: ${e.message}`, 'model');
  if (e instanceof Anthropic.RateLimitError) {
    const after = Number(e.headers?.get?.('retry-after'));
    return new LlmError(`Anthropic rate limit: ${e.message}`, 'rate', Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
  }
  if (e instanceof Anthropic.APIConnectionError) return new LlmError(`Could not reach Anthropic: ${e.message}`, 'network');
  if (e instanceof Anthropic.APIError) {
    const status = Number(e.status);
    if (status === 529 || status >= 500) return new LlmError(`Anthropic is overloaded or unavailable (${status}): ${e.message}`, 'network');
    if (status === 402 || /credit balance|billing/i.test(e.message)) return new LlmError(`The Anthropic account has no credit left: ${e.message}`, 'auth');
    return new LlmError(`${status}: ${e.message}`, 'other');
  }
  return new LlmError(e instanceof Error ? e.message : String(e), 'other');
}

export interface ClaudeTarget {
  key: string;
  model: string;
}

/** Optional request settings a model may refuse; a 400 naming one drops it and asks again. */
const OPTIONAL = ['output_config', 'fallbacks'] as const;

export async function claudeChat(t: ClaudeTarget, req: ChatRequest): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: t.key, maxRetries: 1 });
  const drop = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const params: Record<string, unknown> = {
      model: t.model,
      max_tokens: 32_000,
      system: systemText(req),
      messages: toClaudeMessages(req.messages),
    };
    if (req.tools?.length) {
      // Tool inputs stream as they are generated; the parse below guards against a truncated one.
      params.tools = req.tools.map((x) => ({ name: x.name, description: x.description, input_schema: x.parameters, eager_input_streaming: true }));
    }
    const betas: string[] = [];
    if (req.effort && takesEffort(t.model) && !drop.has('output_config')) params.output_config = { effort: req.effort };
    if (takesFallback(t.model) && !drop.has('fallbacks')) {
      params.fallbacks = 'default';
      betas.push('server-side-fallback-2026-07-01');
    }
    if (betas.length) params.betas = betas;
    try {
      const stream = client.beta.messages.stream(params as never, { signal: req.signal });
      stream.on('text', (delta: string) => req.onToken?.(delta));
      const msg = await stream.finalMessage() as unknown as {
        content: Block[];
        stop_reason: string | null;
        stop_details?: { category?: string | null; explanation?: string } | null;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        model?: string;
      };
      return fromMessage(t.model, msg);
    } catch (e) {
      const err = toLlmError(e, req.signal);
      const setting = err.kind === 'other' && /^400:/.test(err.message) ? OPTIONAL.find((k) => err.message.includes(k) || (k === 'output_config' && /effort/i.test(err.message))) : undefined;
      if (!setting || drop.has(setting) || attempt >= OPTIONAL.length) throw err;
      drop.add(setting);
    }
  }
}

export function fromMessage(model: string, msg: {
  content: Block[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  model?: string;
}): ChatResult {
  const content = echoable(msg.content);
  const text = content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').trim();
  const usage = { input: (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0), output: msg.usage?.output_tokens };
  if (msg.stop_reason === 'refusal') {
    const why = msg.stop_details?.explanation || msg.stop_details?.category || 'no reason given';
    return { text: `${text ? `${text}\n\n` : ''}(Claude declined this request: ${why}.)`, toolCalls: [], provider: 'anthropic', model: msg.model ?? model, usage };
  }
  const uses = content.filter((b) => b.type === 'tool_use');
  if (msg.stop_reason === 'max_tokens' && uses.length) {
    throw new LlmError('Claude ran out of room in the middle of a tool call - the step was not run.', 'other');
  }
  const toolCalls: ToolCall[] = uses.map((b) => ({ id: String(b.id), name: String(b.name), args: b.input && typeof b.input === 'object' ? b.input as Record<string, unknown> : {} }));
  return { text, toolCalls, native: content, provider: 'anthropic', model: msg.model ?? model, usage };
}

/** The Claude models a key can use - also how Settings checks the key. */
export async function claudeModels(key: string): Promise<string[]> {
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000 });
  try {
    const ids: string[] = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    return ids;
  } catch (e) {
    throw toLlmError(e);
  }
}
