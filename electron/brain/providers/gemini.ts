import { GoogleGenAI, ThinkingLevel, type Content, type Part } from '@google/genai';
import { LlmError, newId, type ChatRequest, type ChatResult, type Effort, type LlmMessage, type ToolCall } from '../types';

export interface GeminiModelInfo {
  name: string;
  displayName: string;
  actions: string[];
}

export interface GeminiCatalog {
  checkedAt: number;
  models: GeminiModelInfo[];
  best: string | null;
  /** A different model to try when the best one is overloaded (503). */
  fallback: string | null;
  live: string | null;
  /** Every usable text model, best first - each has its own free daily limit. */
  ranked?: string[];
  /** The "pro" reasoning models, newest first. */
  pro?: string[];
}

const clients = new Map<string, GoogleGenAI>();

function client(apiKey: string): GoogleGenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new GoogleGenAI({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

function classify(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  const err = e as { status?: number; message?: string; name?: string };
  const msg = err?.message ?? String(e);
  if (err?.name === 'AbortError' || /aborted/i.test(msg)) return new LlmError('cancelled', 'aborted');
  const status = err?.status ?? Number(/"code":\s*(\d{3})/.exec(msg)?.[1] ?? /\b(4\d\d|5\d\d)\b/.exec(msg)?.[1] ?? 0);
  // Google explains itself ("API key expired", "reported as leaked", "API not enabled") - pass that on.
  const reason = /"message":\s*"([^"]{1,240})"/.exec(msg)?.[1]?.replace(/AIza[\w-]{10,}/g, 'AIza…');
  if (status === 400 && /api key|API_KEY_INVALID/i.test(msg)) return new LlmError(`Gemini rejected the API key${reason ? ` - Google says: ${reason}` : ''}. Paste a fresh one from aistudio.google.com/apikey.`, 'auth');
  if (status === 401 || /invalid authentication credentials/i.test(msg)) {
    return new LlmError('Google no longer recognises this Gemini key - it was probably deleted or regenerated in AI Studio. Paste the current key from aistudio.google.com/apikey.', 'auth');
  }
  if (status === 403) return new LlmError(`Gemini rejected the API key${reason ? ` - Google says: ${reason}` : ' (permission denied)'}.`, 'auth');
  if (status === 404) return new LlmError(`Gemini model not found: ${msg.slice(0, 160)}`, 'model');
  if (status === 429) {
    // "limit: 0" - this model has no free allowance at all (Pro models on some free keys). Waiting won't help.
    if (/limit["\s:]+0\b/i.test(msg)) return new LlmError('This Gemini model is not included in the free tier.', 'rate');
    const retry = /retry(?:Delay|_delay)?["\s:]+(\d+(?:\.\d+)?)s/i.exec(msg);
    // The free tier has a per-minute and a daily limit; say which, so a slow day makes sense.
    const daily = /PerDay/i.test(msg);
    return new LlmError(daily ? 'Gemini\'s free daily limit is used up (it resets at midnight Pacific time).' : 'Gemini rate limit reached.', 'rate', retry ? Math.ceil(Number(retry[1]) * 1000) : undefined);
  }
  if (status >= 500) return new LlmError(`Gemini server error (${status}).`, 'network');
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(msg)) return new LlmError('Could not reach Gemini (network).', 'network');
  return new LlmError(msg.slice(0, 300), 'other');
}

function parseJsonLoose(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function toContents(messages: LlmMessage[]): Content[] {
  const out: Content[] = [];
  let pendingResponses: Part[] = [];
  let pendingText: string[] = [];
  // Tool calls made by another provider (the local model, after a fallback)
  // carry no thought signature, and Gemini rejects replayed function calls
  // without one - so those turns and their results are passed as plain text.
  const flattened = new Set<string>();
  const flush = () => {
    const parts: Part[] = [...pendingResponses];
    if (pendingText.length) parts.push({ text: pendingText.join('\n\n') });
    if (parts.length) out.push({ role: 'user', parts });
    pendingResponses = [];
    pendingText = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      if (flattened.has(m.callId)) {
        pendingText.push(`[Result of ${m.name}]\n${m.content}`);
        continue;
      }
      const parsed = parseJsonLoose(m.content);
      pendingResponses.push({
        functionResponse: {
          name: m.name,
          id: m.callId.startsWith('g:') ? m.callId.slice(2) : undefined,
          response: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { output: parsed ?? m.content },
        },
      });
      continue;
    }
    flush();
    if (m.role === 'user') {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      out.push({ role: 'user', parts: parts.length ? parts : [{ text: '(no text)' }] });
    } else if (m.nativeProvider === 'gemini' && m.native) {
      // Replaying the model's own content keeps its thought signatures intact,
      // which newer Gemini models require across tool-calling turns.
      out.push(m.native as Content);
    } else {
      const lines: string[] = [];
      if (m.content) lines.push(m.content);
      for (const c of m.toolCalls ?? []) {
        flattened.add(c.id);
        lines.push(`[Called ${c.name} ${JSON.stringify(c.args)}]`);
      }
      out.push({ role: 'model', parts: [{ text: lines.join('\n') || '(no text)' }] });
    }
  }
  flush();
  return out;
}

const FIRST_TOKEN_TIMEOUT_MS = 60_000;
// Deep thinking can sit silent for a while before the first word - that is the model working, not a stall.
const FIRST_TOKEN_TIMEOUT_DEEP_MS = 150_000;
const IDLE_TIMEOUT_MS = 45_000;

const LEVELS: Record<Effort, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };
/* Models that refused a thinking level (older families only take a token budget) - asked without one from then on. */
const noThinkingLevel = new Set<string>();

export async function geminiChat(apiKey: string, model: string, req: ChatRequest): Promise<ChatResult> {
  try {
    return await geminiChatOnce(apiKey, model, req, Boolean(req.effort) && !noThinkingLevel.has(model));
  } catch (e) {
    if (e instanceof LlmError && e.kind === 'other' && req.effort && !noThinkingLevel.has(model) && /thinking/i.test(e.message)) {
      noThinkingLevel.add(model);
      return geminiChatOnce(apiKey, model, req, false);
    }
    throw e;
  }
}

async function geminiChatOnce(apiKey: string, model: string, req: ChatRequest, withLevel: boolean): Promise<ChatResult> {
  const ai = client(apiKey);
  // A stalled stream must not freeze the team - abort it so the router can fall back to the local model.
  const ctrl = new AbortController();
  let stalled = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(idle);
    idle = setTimeout(() => { stalled = true; ctrl.abort(); }, ms);
  };
  const onOuterAbort = () => ctrl.abort();
  req.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const config: Record<string, unknown> = {
    systemInstruction: req.system || undefined,
    temperature: req.temperature ?? 0.6,
    abortSignal: ctrl.signal,
  };
  if (withLevel && req.effort) config.thinkingConfig = { thinkingLevel: LEVELS[req.effort] };
  if (req.tools?.length) {
    config.tools = [{
      functionDeclarations: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    }];
  }
  if (req.json) {
    config.responseMimeType = 'application/json';
    if (req.json !== true) config.responseJsonSchema = req.json;
  }

  let text = '';
  const toolCalls: ToolCall[] = [];
  const allParts: Part[] = [];
  let usage: ChatResult['usage'];

  try {
    arm(req.effort === 'high' ? FIRST_TOKEN_TIMEOUT_DEEP_MS : FIRST_TOKEN_TIMEOUT_MS);
    const stream = await ai.models.generateContentStream({ model, contents: toContents(req.messages), config });
    for await (const chunk of stream) {
      arm(IDLE_TIMEOUT_MS);
      const um = chunk.usageMetadata;
      if (um) usage = { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0, thinking: um.thoughtsTokenCount ?? 0 };
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        allParts.push(part);
        if (part.thought) continue;
        if (typeof part.text === 'string' && part.text) {
          text += part.text;
          req.onToken?.(part.text);
        }
        if (part.functionCall?.name) {
          toolCalls.push({
            id: part.functionCall.id ? `g:${part.functionCall.id}` : newId('t'),
            name: part.functionCall.name,
            args: (part.functionCall.args as Record<string, unknown>) ?? {},
          });
        }
      }
    }
  } catch (e) {
    // Only the operator's own cancel is "cancelled". An SDK timeout that happens to say "aborted" once ended a
    // whole team run as cancelled (live test, 26 Sep 2026) - it's a network error the router can recover from.
    if (req.signal?.aborted) throw new LlmError('cancelled', 'aborted');
    if (stalled) throw new LlmError('Gemini stopped responding.', 'network');
    const err = classify(e);
    if (err.kind === 'aborted') throw new LlmError('The Gemini request was cut off.', 'network');
    throw err;
  } finally {
    clearTimeout(idle);
    req.signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!text && !toolCalls.length && !allParts.length) {
    throw new LlmError('Gemini returned an empty response (possibly blocked by a safety filter).', 'other');
  }

  return {
    text: text.trim(),
    toolCalls,
    native: { role: 'model', parts: allParts },
    provider: 'gemini',
    model,
    usage,
  };
}

/* ── Model discovery ─────────────────────────────────────────────────────
   Google retires model names on a schedule (gemini-2.0-flash, which this app
   used to hardcode, is gone). Listing the models the key can actually use
   and picking the newest Flash keeps the app working as names change.      */

const EXCLUDE = /(embed|image|tts|audio|live|robotics|computer-use|learnlm|aqa|gemma|exp-\d|-exp$|imagen|veo|lyria|thinking-exp)/i;

function versionOf(name: string): number {
  const m = /gemini-(\d+(?:\.\d+)?)/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** Google's strongest reasoning models ("pro"), newest first - for the hardest problems when the key allows them. */
export function proModels(models: GeminiModelInfo[]): string[] {
  const score = (n: string) => versionOf(n) * 100 - (/preview/.test(n) ? 5 : 0) - (/\d{3,}$/.test(n) ? 2 : 0) - (/-latest$/.test(n) ? 1 : 0) - (/customtools|tts|image/.test(n) ? 100 : 0);
  return models
    .filter((m) => m.actions.includes('generateContent') && !EXCLUDE.test(m.name) && /-pro\b/.test(m.name) && !/flash/.test(m.name))
    .map((m) => m.name)
    .sort((a, b) => score(b) - score(a));
}

export function rankGeminiModels(models: GeminiModelInfo[]): { best: string | null; fallback: string | null; live: string | null; ranked: string[] } {
  const textModels = models.filter((m) => m.actions.includes('generateContent') && !EXCLUDE.test(m.name));
  const score = (n: string) => {
    let s = versionOf(n) * 100;
    if (/flash-lite/.test(n)) s += 10;
    else if (/flash/.test(n)) s += 30;
    else if (/pro/.test(n)) s += 20;
    if (/preview/.test(n)) s -= 5;
    if (/-latest$/.test(n)) s -= 1; // prefer a pinned name at the same score
    if (/\d{3,}$/.test(n)) s -= 2; // dated snapshot suffixes
    return s;
  };
  const ranked = [...textModels].sort((a, b) => score(b.name) - score(a.name));
  const best = ranked[0]?.name ?? null;
  // Skip dated snapshots and aliases of the same model - an overload usually hits all of them at once.
  const family = (n: string) => n.replace(/-(preview|latest|\d{3,}|\d{2}-\d{4})(-.*)?$/, '');
  const fallback = best ? ranked.find((m) => family(m.name) !== family(best) && /flash|pro/.test(m.name))?.name ?? null : null;

  const liveModels = models.filter((m) => m.actions.includes('bidiGenerateContent'));
  const liveRanked = [...liveModels].sort((a, b) => {
    const s = (n: string) => versionOf(n) * 100 + (/native-audio/.test(n) ? 5 : 0) - (/preview/.test(n) ? 1 : 0);
    return s(b.name) - s(a.name);
  });
  return { best, fallback, live: liveRanked[0]?.name ?? null, ranked: ranked.map((m) => m.name) };
}

export async function listGeminiModels(apiKey: string): Promise<GeminiCatalog> {
  const ai = client(apiKey);
  const models: GeminiModelInfo[] = [];
  try {
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    for await (const m of pager) {
      if (!m.name) continue;
      models.push({
        name: m.name.replace(/^models\//, ''),
        displayName: m.displayName ?? m.name,
        actions: m.supportedActions ?? [],
      });
    }
  } catch (e) {
    throw classify(e);
  }
  const { best, fallback, live, ranked } = rankGeminiModels(models);
  return { checkedAt: Date.now(), models, best, fallback, live, ranked, pro: proModels(models) };
}

/* ── Google Search grounding ─────────────────────────────────────────────
   Gemini answering with Google Search behind it: real, current results
   with sources, and no search page for a bot check to block.            */

export interface GroundedAnswer {
  answer: string;
  sources: { title: string; url: string }[];
  queries: string[];
}

/** Grounding links are Google redirects ("vertexaisearch.cloud.google.com/grounding-api-redirect/...") - show where they go. */
async function realUrl(url: string): Promise<string> {
  if (!/grounding-api-redirect/.test(url)) return url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    return res.headers.get('location') || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

export async function geminiGrounded(apiKey: string, model: string, question: string, signal?: AbortSignal): Promise<GroundedAnswer> {
  const ai = client(apiKey);
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: question }] }],
      config: {
        tools: [{ googleSearch: {} }, { urlContext: {} }],
        systemInstruction: 'Answer from what Google Search finds today. Be specific: names, numbers, dates. Say plainly when the sources disagree or do not answer the question.',
        temperature: 0.3,
        abortSignal: signal,
      },
    });
    const cand = res.candidates?.[0];
    const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const raw = chunks
      .map((c) => ({ title: c.web?.title ?? '', url: c.web?.uri ?? '' }))
      .filter((s) => s.url && !seen.has(s.url) && seen.add(s.url))
      .slice(0, 8);
    const urls = await Promise.all(raw.map((s) => realUrl(s.url)));
    return {
      answer: (res.text ?? '').trim(),
      sources: raw.map((s, i) => ({ title: s.title, url: urls[i] })),
      queries: cand?.groundingMetadata?.webSearchQueries ?? [],
    };
  } catch (e) {
    throw classify(e);
  }
}
