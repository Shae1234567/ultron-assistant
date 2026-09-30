import { LlmError, newId, type ChatRequest, type ChatResult, type ToolCall } from '../types';

export interface OllamaTarget {
  host: string;
  model: string;
  numCtx: number;
}

const IDLE_TIMEOUT_MS = 120_000;
const capabilityCache = new Map<string, string[]>();

/** Model capabilities from /api/show ("tools", "thinking", "vision"...), cached per model. */
export async function ollamaCapabilities(host: string, model: string): Promise<string[]> {
  const key = `${host}|${model}`;
  const hit = capabilityCache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(`${host}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { capabilities?: string[] };
    const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
    capabilityCache.set(key, caps);
    return caps;
  } catch {
    return [];
  }
}

function toOllamaMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.content,
        ...(m.images?.length ? { images: m.images.map((i) => i.data) } : {}),
      });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) }
          : {}),
      });
    } else {
      out.push({ role: 'tool', content: m.content, tool_name: m.name });
    }
  }
  return out;
}

/** Some models inline their reasoning as <think> tags when the think flag isn't honoured. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export async function ollamaChat(target: OllamaTarget, req: ChatRequest): Promise<ChatResult> {
  const caps = await ollamaCapabilities(target.host, target.model);
  const supportsThinking = caps.includes('thinking');
  const supportsTools = caps.length === 0 || caps.includes('tools');

  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  req.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
  };

  const body: Record<string, unknown> = {
    model: target.model,
    messages: toOllamaMessages(req),
    stream: true,
    keep_alive: '2h',
    options: { temperature: req.temperature ?? 0.5, num_ctx: target.numCtx },
  };
  if (req.tools?.length && supportsTools) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
  }
  if (req.json) body.format = req.json === true ? 'json' : req.json;
  // The local model reasons out loud only when a step is worth the wait.
  if (supportsThinking) body.think = Boolean(req.think ?? req.effort === 'high');

  let text = '';
  let usage: ChatResult['usage'];
  const toolCalls: ToolCall[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    armIdle();
    const res = await fetch(`${target.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 404) throw new LlmError(`Ollama model "${target.model}" is not installed. Run: ollama pull ${target.model}`, 'model');
      throw new LlmError(`Ollama ${res.status}: ${detail || 'no response body'}`, 'other');
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let json: { message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }; error?: string; prompt_eval_count?: number; eval_count?: number };
      try {
        json = JSON.parse(line);
      } catch {
        return; // a malformed frame shouldn't sink the whole reply
      }
      if (json.error) throw new LlmError(json.error, 'other');
      if (typeof json.eval_count === 'number') usage = { input: json.prompt_eval_count ?? 0, output: json.eval_count };
      const token = json.message?.content;
      if (token) {
        text += token;
        req.onToken?.(token);
      }
      for (const call of json.message?.tool_calls ?? []) {
        const name = call.function?.name;
        if (!name) continue;
        let args = call.function?.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        toolCalls.push({ id: newId('t'), name, args: (args as Record<string, unknown>) ?? {} });
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    // Ollama's final {"done":true} frame often arrives without a trailing newline.
    if (buffer.trim()) handleLine(buffer);
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      if (req.signal?.aborted) throw new LlmError('cancelled', 'aborted');
      throw new LlmError('Ollama stopped responding.', 'network');
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new LlmError(/ECONNREFUSED|fetch failed/i.test(msg) ? 'Ollama is not running.' : msg, 'network');
  } finally {
    clearTimeout(idle);
    req.signal?.removeEventListener('abort', onOuterAbort);
    if (reader) { try { await reader.cancel(); } catch { /* already closed */ } }
  }

  return { text: stripThinking(text), toolCalls, provider: 'ollama', model: target.model, usage };
}

export async function ollamaEmbed(host: string, model: string, inputs: string[]): Promise<number[][]> {
  const res = await fetch(`${host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs, keep_alive: '2h' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  if (!Array.isArray(data.embeddings)) throw new Error('Ollama embed returned no vectors');
  return data.embeddings;
}

/**
 * Loads the chat model into memory ahead of the first request (an empty
 * prompt only loads it) so the operator's first message doesn't pay the
 * load time; it then stays warm for two hours between uses.
 */
export async function warmUp(host: string, model: string): Promise<void> {
  await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', keep_alive: '2h' }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {});
}
