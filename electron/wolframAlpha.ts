import { getSecret } from './secrets';

/**
 * WolframAlpha connector, via the free "Short Answers" REST API.
 *
 * Setup an operator needs (for Settings UI copy):
 *  1. Sign up for a free WolframAlpha AppID at
 *     https://developer.wolframalpha.com/access - that's WOLFRAM_APP_ID.
 *  2. The Short Answers API returns a single plain-text line answering a
 *     query (math, unit conversions, facts, etc). It's not JSON - the
 *     response body itself is the answer.
 */

const TIMEOUT_MS = 10000;

function appId(): string {
  return getSecret('WOLFRAM_APP_ID');
}

export function hasKey(): boolean {
  return Boolean(appId());
}

/** Asks WolframAlpha's Short Answers API a natural-language or math query. */
export async function askWolframAlpha(query: string): Promise<{ ok: boolean; answer?: string; error?: string }> {
  const id = appId();
  if (!id) return { ok: false, error: 'No WOLFRAM_APP_ID set.' };
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: 'Query is empty.' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `https://api.wolframalpha.com/v1/result?appid=${id}&i=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, error: 'WolframAlpha could not answer that.' };
    }
    const answer = (await res.text()).trim();
    if (!answer) {
      return { ok: false, error: 'WolframAlpha could not answer that.' };
    }
    return { ok: true, answer };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
