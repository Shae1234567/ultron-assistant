import { getSettings, saveSettings } from '../store';
import { getSecret } from '../secrets';
import * as ollama from '../ollama';
import { ollamaChat } from './providers/ollama';
import { geminiChat, geminiGrounded, listGeminiModels, type GeminiCatalog, type GroundedAnswer } from './providers/gemini';
import { openaiChat, openaiModels } from './providers/openaiCompat';
import { claudeChat, claudeModels } from './providers/anthropic';
import { LlmError, providerName, type ChatRequest, type ChatResult, type JsonSchema, type Provider } from './types';
import { extractJson } from './json';
import { record } from './meter';
import { workflow } from './workflow';

/**
 * The one place that decides which brain answers. Every call in the app -
 * the lead, each specialist, memory extraction, news blurbs - goes through
 * chat(), which picks a provider per call and falls back to the next one on
 * rate limits, outages, or a bad key instead of failing the whole run.
 *
 * Providers: Gemini, Claude (Anthropic), any OpenAI-compatible service, and a
 * local model through Ollama. Settings -> Brain picks one (or Automatic: the
 * first cloud provider with a key); the local model is the backup.
 */

export interface GeminiState {
  configured: boolean;
  valid: boolean | null;
  model: string | null;
  liveModel: string | null;
  models: string[];
  error?: string;
  checkedAt?: number;
}

/** Claude or an OpenAI-compatible service: whether it has a key, the model it will use, and whether the key worked. */
export interface CloudState {
  configured: boolean;
  model: string | null;
  valid: boolean | null;
  error?: string;
}

export interface BrainStatus {
  active: Provider | null;
  label: string;
  model: string | null;
  gemini: GeminiState;
  openai: CloudState;
  anthropic: CloudState;
  ollama: ollama.OllamaStatus;
}

type OtherCloud = 'openai' | 'anthropic';
const cloudValid: Record<OtherCloud, boolean | null> = { openai: null, anthropic: null };
const cloudError: Record<OtherCloud, string | undefined> = { openai: undefined, anthropic: undefined };
const cloudKeySeen: Record<OtherCloud, string> = { openai: '', anthropic: '' };
/** Until when a provider rests after a rate limit or an overload (Gemini keeps its own rateLimitedUntil). */
const restingUntil: Record<OtherCloud, number> = { openai: 0, anthropic: 0 };

function keyOf(p: OtherCloud): string {
  return getSecret(p === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');
}

function modelOf(p: OtherCloud): string | null {
  const s = getSettings();
  return ((p === 'openai' ? s.openai?.model : s.anthropic?.model) ?? '').trim() || null;
}

export function cloudState(p: OtherCloud): CloudState {
  const key = keyOf(p);
  if (cloudKeySeen[p] !== key) {
    // A new key starts unchecked.
    cloudKeySeen[p] = key;
    cloudValid[p] = null;
    cloudError[p] = undefined;
  }
  // A local OpenAI-compatible server (LM Studio and the like) needs no key.
  const configured = p === 'openai'
    ? Boolean(modelOf(p)) && (Boolean(key) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(getSettings().openai?.baseUrl ?? ''))
    : Boolean(key);
  return { configured, model: configured ? modelOf(p) : null, valid: configured ? cloudValid[p] : null, error: configured ? cloudError[p] : undefined };
}

function cloudUsable(p: OtherCloud): boolean {
  const st = cloudState(p);
  return st.configured && st.valid !== false && Boolean(st.model);
}

/** Settings -> "Check": lists the models the key can use, which also proves the key works. */
export async function checkCloud(p: OtherCloud): Promise<CloudState & { models?: string[] }> {
  cloudState(p);
  try {
    const models = p === 'openai' ? await openaiModels(getSettings().openai.baseUrl, keyOf(p)) : await claudeModels(keyOf(p));
    cloudValid[p] = true;
    cloudError[p] = undefined;
    return { ...cloudState(p), models };
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError(e instanceof Error ? e.message : String(e), 'other');
    if (err.kind === 'auth') cloudValid[p] = false;
    cloudError[p] = err.message;
    return cloudState(p);
  }
}

let catalog: GeminiCatalog | null = null;
let catalogKey = '';
let geminiError: string | undefined;
let geminiValid: boolean | null = null;
let rateLimitedUntil = 0;
let lastListAttempt = 0;

export async function refreshGemini(force = false): Promise<GeminiState> {
  const key = getSecret('GEMINI_API_KEY');
  if (!key) {
    catalog = null;
    catalogKey = '';
    geminiValid = null;
    geminiError = undefined;
    return geminiState();
  }
  const stale = !catalog || catalogKey !== key || Date.now() - catalog.checkedAt > 6 * 3600_000;
  if (force || stale) {
    lastListAttempt = Date.now();
    try {
      catalog = await listGeminiModels(key);
      catalogKey = key;
      geminiValid = Boolean(catalog.best);
      geminiError = catalog.best ? undefined : 'This key has no usable Gemini text models.';
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError(String(e), 'other');
      geminiValid = err.kind === 'auth' ? false : geminiValid;
      geminiError = err.message;
      if (err.kind === 'auth') catalog = null;
    }
  }
  return geminiState();
}

/* Models Google answered "not found / no longer available" this session. A Settings that pinned
   gemini-2.5-flash after Google retired it for new keys (26 Sep 2026) sent every request to the
   small local model, which then fumbled simple jobs. A retired model is skipped from then on. */
const retiredModels = new Set<string>();

/* The free tier's DAILY limit is per model. When one model's is used up (26 Sep 2026: after a day of testing),
   the next Gemini model still has its own - far better than the small local model - until the reset. */
const exhaustedUntil = new Map<string, number>();

/** Next midnight in California, when Gemini's free daily limits reset. */
export function nextPacificMidnight(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = wallClockAsUtc - Math.floor(now / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day + 1) - offset;
}

/* Models the key's free tier does not include at all ("limit: 0" - Pro, on many free keys). */
const notInPlan = new Set<string>();

function usableModel(name: string | null | undefined): name is string {
  return Boolean(name) && !retiredModels.has(name!) && !notInPlan.has(name!) && (exhaustedUntil.get(name!) ?? 0) <= Date.now();
}

/** Google's strongest reasoning model this key can use right now - for the hardest steps. */
function strongestModel(): string | null {
  return (catalog?.pro ?? []).find(usableModel) ?? null;
}

/**
 * The operator's Thinking setting: Deep uses the strongest model and full
 * reasoning where a step asks for it, Balanced keeps the reasoning but stays
 * on Flash, Fast caps the reasoning for quicker replies.
 */
export function tuned(req: ChatRequest, mode = getSettings().thinking, wf = workflow()): ChatRequest {
  // The v1 workflow predates reasoning levels - every call used the model's default.
  if (!wf.effort) return { ...req, effort: undefined, deep: false };
  if (mode === 'balanced') return { ...req, deep: false };
  if (mode === 'fast') return { ...req, deep: false, effort: req.effort === 'high' ? 'medium' : req.effort, think: false };
  return req;
}

function chosenGeminiModel(): string | null {
  const configured = getSettings().gemini.model.trim();
  const candidates = [configured, ...(catalog?.ranked ?? []), catalog?.best, catalog?.fallback];
  return candidates.find(usableModel) ?? null;
}

/** The Gemini model Ultron would use right now (for add-ons that call Gemini themselves), or null when there is none. */
export function activeGeminiModel(): string | null {
  return geminiUsable() ? chosenGeminiModel() : null;
}

function geminiState(): GeminiState {
  const configured = Boolean(getSecret('GEMINI_API_KEY'));
  return {
    configured,
    valid: configured ? geminiValid : null,
    model: configured ? chosenGeminiModel() : null,
    liveModel: catalog?.live ?? null,
    models: catalog?.models.filter((m) => m.actions.includes('generateContent')).map((m) => m.name) ?? [],
    error: configured ? geminiError : undefined,
    checkedAt: catalog?.checkedAt,
  };
}

function geminiUsable(): boolean {
  return Boolean(getSecret('GEMINI_API_KEY')) && geminiValid !== false && Boolean(chosenGeminiModel());
}

let lastOllama: ollama.OllamaStatus | null = null;
let lastOllamaAt = 0;

async function ollamaUsable(): Promise<boolean> {
  if (!lastOllama || Date.now() - lastOllamaAt > 15_000) {
    lastOllama = await ollama.status();
    lastOllamaAt = Date.now();
  }
  return lastOllama.running && lastOllama.modelInstalled;
}

export async function brainStatus(): Promise<BrainStatus> {
  const [o] = await Promise.all([ollama.status(), refreshGemini()]);
  lastOllama = o;
  lastOllamaAt = Date.now();
  const g = geminiState();
  const s = getSettings();
  const gOk = g.configured && g.valid !== false && Boolean(g.model);
  const oOk = o.running && o.modelInstalled;
  const ok: Record<Provider, boolean> = { gemini: gOk, anthropic: cloudUsable('anthropic'), openai: cloudUsable('openai'), ollama: oOk };
  let active: Provider | null = null;
  if (s.brain === 'ollama') active = oOk ? 'ollama' : null;
  else if (s.brain !== 'auto') active = ok[s.brain] ? s.brain : oOk ? 'ollama' : null;
  else active = CLOUD_ORDER.find((p) => ok[p]) ?? (oOk ? 'ollama' : null);
  const model = active === 'gemini' ? g.model : active === 'ollama' ? o.activeModel : active ? modelOf(active) : null;
  const label = active ? `${active === 'ollama' ? 'LOCAL MODEL' : providerName(active).toUpperCase()} ONLINE` : 'BRAIN OFFLINE';
  return { active, label, model, gemini: g, openai: cloudState('openai'), anthropic: cloudState('anthropic'), ollama: o };
}

/** Automatic's order among the cloud providers that have keys. */
const CLOUD_ORDER = ['gemini', 'anthropic', 'openai'] as const;

async function providerOrder(tier: 'main' | 'fast'): Promise<Provider[]> {
  // A model list that failed once (network blip at boot, a key pasted since) is retried here,
  // at most once a minute - otherwise Gemini would sit unused for the whole session.
  const key = getSecret('GEMINI_API_KEY');
  if (key && (!catalog || catalogKey !== key) && geminiValid !== false && Date.now() - lastListAttempt > 60_000) await refreshGemini();
  const choice = getSettings().brain;
  const o = await ollamaUsable();
  const ok: Record<Provider, boolean> = {
    gemini: geminiUsable() && Date.now() >= rateLimitedUntil,
    anthropic: cloudUsable('anthropic') && Date.now() >= restingUntil.anthropic,
    openai: cloudUsable('openai') && Date.now() >= restingUntil.openai,
    ollama: o,
  };
  const firstCloud = CLOUD_ORDER.find((p) => ok[p]);
  const order: Provider[] = [];
  if (choice === 'ollama') {
    if (o) order.push('ollama');
  } else if (choice !== 'auto') {
    if (ok[choice]) order.push(choice);
    if (o) order.push('ollama');
  } else if (tier === 'fast') {
    if (o) order.push('ollama');
    if (firstCloud) order.push(firstCloud);
  } else {
    if (firstCloud) order.push(firstCloud);
    if (o) order.push('ollama');
  }
  // Everything is resting after a rate limit, but a cloud provider exists: try it rather than nothing.
  if (!order.length) {
    const resting = choice !== 'auto' && choice !== 'ollama' ? [choice] : [...CLOUD_ORDER];
    const usable = resting.find((p) => (p === 'gemini' ? geminiUsable() : cloudUsable(p)));
    if (usable) order.push(usable);
  }
  return order;
}

/** Which provider will most likely answer a call on this tier - lets callers size their prompts. */
export async function preferredProvider(tier: 'main' | 'fast' = 'main'): Promise<Provider | null> {
  return (await providerOrder(tier))[0] ?? null;
}

const OVERLOADED = /server error|overloaded|stopped responding|unavailable/i;

async function callProvider(p: Provider, req: ChatRequest): Promise<ChatResult> {
  if (p === 'gemini') {
    const key = getSecret('GEMINI_API_KEY');
    let model = (req.deep ? strongestModel() : null) ?? chosenGeminiModel();
    const busyThisCall = new Set<string>();
    // One request can meet several problems in a row (live, 26 Sep 2026: a retired pinned model, then a used-up
    // one, then a busy one) - keep moving through Gemini models before anything goes to the small local model.
    for (let hop = 0; hop < 5; hop++) {
      if (!model) throw new LlmError('No Gemini model available.', 'model');
      try {
        return await geminiChat(key, model, req);
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        let note: string;
        if (e.kind === 'model') {
          // Retired (404): never again this session.
          retiredModels.add(model);
          const pinned = getSettings().gemini.model.trim() === model;
          note = `${model} is no longer available from Google`;
          // A pinned model Google retired would cost a failed call every session - go back to Automatic for good.
          if (pinned) {
            saveSettings({ gemini: { model: '' } });
            note += ' (Settings is back on Automatic)';
          }
        } else if (e.kind === 'rate' && /not included in the free tier/i.test(e.message)) {
          notInPlan.add(model);
          note = `${model} is not part of your free Gemini plan`;
        } else if (e.kind === 'rate' && req.deep && catalog?.pro?.includes(model) && !/daily limit/i.test(e.message)) {
          // Pro's per-minute allowance is small; the next-best model answers now rather than waiting on it.
          busyThisCall.add(model);
          note = `${model} is at its per-minute limit`;
        } else if (e.kind === 'rate' && /daily limit/i.test(e.message)) {
          // Its free DAILY limit is used up - the next model has its own, until midnight Pacific.
          exhaustedUntil.set(model, nextPacificMidnight());
          note = `${model} used up its free daily limit`;
        } else if (e.kind === 'network' && OVERLOADED.test(e.message)) {
          // Busy (503) is usually a capacity blip on that one model - try another for this request only.
          busyThisCall.add(model);
          note = `${model} is overloaded`;
        } else {
          throw e;
        }
        const next = [chosenGeminiModel(), ...(catalog?.ranked ?? [])].find((m) => usableModel(m) && !busyThisCall.has(m!)) ?? null;
        if (!next || next === model) throw e;
        req.onNotice?.(`${note} - switching to ${next}.`);
        model = next;
      }
    }
    throw new LlmError('Every Gemini model tried was unavailable.', 'network');
  }
  if (p === 'openai') {
    return openaiChat({ baseUrl: getSettings().openai.baseUrl, key: keyOf('openai'), model: modelOf('openai') ?? '' }, req);
  }
  if (p === 'anthropic') {
    return claudeChat({ key: keyOf('anthropic'), model: modelOf('anthropic') ?? '' }, req);
  }
  const s = getSettings();
  return ollamaChat(
    { host: s.ollama.host.replace(/\/$/, ''), model: s.ollama.model, numCtx: s.ollama.numCtx },
    req,
  );
}

/*
 * Specialists and their helpers run in parallel, so calls are metered per
 * provider: a handful at once for Gemini (its free tier counts requests per
 * minute), fewer for the local model (one GPU - more at once only makes each
 * slower). Callers queue for a slot instead of piling on.
 */
const SLOTS: Record<Provider, number> = { gemini: 4, openai: 4, anthropic: 4, ollama: 2 };
const busy: Record<Provider, number> = { gemini: 0, openai: 0, anthropic: 0, ollama: 0 };
const queue: Record<Provider, (() => void)[]> = { gemini: [], openai: [], anthropic: [], ollama: [] };

function acquire(p: Provider, signal?: AbortSignal): Promise<() => void> {
  const release = () => {
    const next = queue[p].shift();
    if (next) next();
    else busy[p]--;
  };
  if (busy[p] < SLOTS[p]) {
    busy[p]++;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(release);
    };
    const onAbort = () => {
      const i = queue[p].indexOf(grant);
      if (i >= 0) queue[p].splice(i, 1);
      reject(new LlmError('cancelled', 'aborted'));
    };
    queue[p].push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function metered(p: Provider, req: ChatRequest): Promise<ChatResult> {
  const release = await acquire(p, req.signal);
  try {
    const res = await callProvider(p, req);
    record(res.model, res.usage);
    return res;
  } finally {
    release();
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new LlmError('cancelled', 'aborted')); }, { once: true });
  });

export async function chat(request: ChatRequest): Promise<ChatResult> {
  const req = tuned(request);
  const order = await providerOrder(req.tier ?? 'main');
  if (!order.length) {
    throw new LlmError(
      'No AI is set up yet: add a key for Gemini, Claude or an OpenAI-compatible service in Settings -> Brain, or install Ollama for a local model.',
      'network',
    );
  }
  let lastError: LlmError | null = null;
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    try {
      return await metered(p, req);
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError(e instanceof Error ? e.message : String(e), 'other');
      if (err.kind === 'aborted') throw err;
      lastError = err;
      if (p === 'gemini') {
        if (err.kind === 'auth') { geminiValid = false; geminiError = err.message; }
        if (err.kind === 'model') void refreshGemini(true);
        if (err.kind === 'rate') {
          const wait = err.retryAfterMs ?? 0;
          // A short wait for Gemini beats handing the main work to the small local model, which fumbled app
          // jobs whenever the free tier's rate limit hit in testing. Only when Google says the wait is short.
          const main = (req.tier ?? 'main') === 'main';
          if (wait > 0 && wait <= (main ? 25_000 : 12_000) && (main || order.length === 1)) {
            req.onNotice?.(`Gemini is busy - waiting ${Math.ceil(wait / 1000)}s instead of switching to the local model.`);
            await sleep(wait, req.signal);
            try { return await metered(p, req); } catch (e2) { lastError = e2 instanceof LlmError ? e2 : lastError; }
          }
          rateLimitedUntil = Date.now() + Math.max(wait, 20_000);
        }
        // Both Gemini models busy: stop ping-ponging back to it for a few seconds.
        if (err.kind === 'network' && OVERLOADED.test(err.message)) rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + 15_000);
      } else if (p === 'openai' || p === 'anthropic') {
        if (err.kind === 'auth') { cloudValid[p] = false; cloudError[p] = err.message; }
        if (err.kind === 'rate') {
          const wait = err.retryAfterMs ?? 0;
          const main = (req.tier ?? 'main') === 'main';
          if (wait > 0 && wait <= (main ? 25_000 : 12_000) && (main || order.length === 1)) {
            req.onNotice?.(`${providerName(p)} is busy - waiting ${Math.ceil(wait / 1000)}s.`);
            await sleep(wait, req.signal);
            try { return await metered(p, req); } catch (e2) { lastError = e2 instanceof LlmError ? e2 : lastError; }
          }
          restingUntil[p] = Date.now() + Math.max(wait, 20_000);
        }
        if (err.kind === 'network' && OVERLOADED.test(err.message)) restingUntil[p] = Math.max(restingUntil[p], Date.now() + 15_000);
      }
      const next = order[i + 1];
      if (next) req.onNotice?.(`${providerName(p)} failed (${err.message}) - ${providerName(next)} is taking over.`);
      // A partially-streamed reply from the failed provider must not be glued
      // onto the next provider's reply - the caller resets on this notice.
    }
  }
  throw lastError ?? new LlmError('The brain failed.', 'other');
}

export async function chatJson<T>(req: Omit<ChatRequest, 'json' | 'onToken'> & { schema?: JsonSchema }): Promise<T | null> {
  const { schema, ...rest } = req;
  const first = await chat({ ...rest, json: schema ?? true });
  const parsed = extractJson<T>(first.text);
  if (parsed) return parsed;
  const retry = await chat({
    ...rest,
    json: schema ?? true,
    messages: [
      ...rest.messages,
      { role: 'assistant', content: first.text.slice(0, 2000) },
      { role: 'user', content: 'That was not valid JSON. Reply again with ONLY the JSON object, nothing else.' },
    ],
  });
  return extractJson<T>(retry.text);
}

/**
 * A question answered by Gemini with Google Search behind it - current facts
 * with their sources, and no search page for a bot check to block. Not used
 * when the operator chose the local model only.
 */
export async function groundedSearch(question: string, signal?: AbortSignal): Promise<GroundedAnswer> {
  if (getSettings().brain === 'ollama') throw new LlmError('Ultron is set to use only the local model, so Google Search (which runs through Gemini) is off.', 'other');
  const key = getSecret('GEMINI_API_KEY');
  if (!key || !geminiUsable()) throw new LlmError('Google Search needs a working Gemini key.', 'auth');
  let model = chosenGeminiModel();
  for (let hop = 0; hop < 3 && model; hop++) {
    const release = await acquire('gemini', signal);
    try {
      return await geminiGrounded(key, model, question, signal);
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      if (e.kind === 'model') retiredModels.add(model);
      else if (e.kind === 'rate' && /daily limit/i.test(e.message)) exhaustedUntil.set(model, nextPacificMidnight());
      else if (e.kind === 'rate' && /not included in the free tier/i.test(e.message)) notInPlan.add(model);
      else throw e;
      model = chosenGeminiModel();
    } finally {
      release();
    }
  }
  throw new LlmError('No Gemini model could search right now.', 'rate');
}
