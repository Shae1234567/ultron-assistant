import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one request costs: model calls, tokens and time - counted for every
 * model call made while answering it, including the ones tools make
 * (deep_research, google_search). The free Gemini tier is paid for in daily
 * request and token limits, so a runaway loop costs the operator the rest of
 * the day; limits stop the work gracefully (the team writes up what it has)
 * instead of letting it spin.
 */

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Calls per model, e.g. {"gemini-3.8-flash": 9, "gemini-3.1-pro": 2}. */
  byModel: Record<string, number>;
}

export interface Limits {
  maxCalls: number;
  maxTokens: number;
  /** Wall-clock limit for the whole request. */
  maxMs: number;
}

export interface Meter {
  startedAt: number;
  limits: Limits;
  usage: Usage;
  /** Why the work was cut short, once a limit was hit. */
  stopped?: string;
}

const store = new AsyncLocalStorage<Meter>();

export function newMeter(limits: Limits, now = Date.now()): Meter {
  return { startedAt: now, limits, usage: { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, byModel: {} } };
}

/** Runs one request with its meter: every chat() inside it - however deep in tools - is counted. */
export function withMeter<T>(meter: Meter, fn: () => Promise<T>): Promise<T> {
  return store.run(meter, fn);
}

export function currentMeter(): Meter | undefined {
  return store.getStore();
}

export interface CallUsage { input?: number; output?: number; thinking?: number }

export function record(model: string, u: CallUsage | undefined, meter = currentMeter()): void {
  if (!meter) return;
  meter.usage.calls++;
  meter.usage.inputTokens += u?.input ?? 0;
  meter.usage.outputTokens += u?.output ?? 0;
  meter.usage.thinkingTokens += u?.thinking ?? 0;
  meter.usage.byModel[model] = (meter.usage.byModel[model] ?? 0) + 1;
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.thinkingTokens;
}

/** Which limit this request has reached, if any - the caller wraps up instead of starting more work. */
export function overBudget(meter = currentMeter(), now = Date.now()): string | null {
  if (!meter) return null;
  if (meter.stopped) return meter.stopped;
  const { limits, usage } = meter;
  let why: string | null = null;
  if (usage.calls >= limits.maxCalls) why = `the limit of ${limits.maxCalls} model calls for one request`;
  else if (totalTokens(usage) >= limits.maxTokens) why = `the limit of ${Math.round(limits.maxTokens / 1000)}k tokens for one request`;
  else if (now - meter.startedAt >= limits.maxMs) why = `the ${Math.round(limits.maxMs / 60_000)}-minute time limit`;
  if (why) meter.stopped = why;
  return why;
}

/** "14 model calls · 48k tokens · 52 s" - the cost line shown after every team run. */
export function describeUsage(meter: Meter, now = Date.now()): string {
  const k = totalTokens(meter.usage);
  const tokens = k >= 1000 ? `${Math.round(k / 1000)}k tokens` : `${k} tokens`;
  return `${meter.usage.calls} model call${meter.usage.calls === 1 ? '' : 's'} · ${tokens} · ${Math.round((now - meter.startedAt) / 1000)} s`;
}
