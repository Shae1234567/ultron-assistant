import { getSecret } from './secrets';
import { getSettings, getQuota, reserveQuota, releaseQuota, getNewsCache, saveNewsCache } from './store';

export type Region =
  | 'NORTH AMERICA' | 'EUROPE' | 'MIDDLE EAST' | 'ASIA-PACIFIC'
  | 'AFRICA' | 'LATIN AMERICA' | 'GLOBAL';

export interface Article {
  id: string;
  title: string;
  description: string;
  content: string;
  url: string;
  image: string | null;
  publishedAt: string;
  source: string;
  category: string;
  region: Region;
}

export interface NewsResult {
  articles: Article[];
  quota: { used: number; cap: number; date: string };
  fetchedAt: number;
  error?: string;
  blocked?: boolean;
  /** True when served from the on-disk cache without spending a request. */
  cached?: boolean;
}

/**
 * Region tagging is a deterministic keyword match, not a guess dressed up as data.
 * Anything that does not match lands in GLOBAL rather than being forced into a bucket.
 */
const REGION_KEYWORDS: Record<Exclude<Region, 'GLOBAL'>, string[]> = {
  'NORTH AMERICA': [
    'canada', 'canadian', 'ottawa', 'toronto', 'calgary', 'alberta', 'ontario', 'quebec',
    'vancouver', 'montreal', 'united states', 'america', 'american',
    'washington', 'white house', 'congress', 'pentagon', 'new york', 'california',
    'texas', 'florida', 'carney',
  ],
  EUROPE: [
    'europe', 'european', 'brussels', 'britain', 'british', 'london',
    'france', 'french', 'paris', 'germany', 'german', 'berlin', 'italy', 'italian', 'rome',
    'spain', 'spanish', 'madrid', 'ukraine', 'ukrainian', 'kyiv', 'russia', 'russian',
    'moscow', 'putin', 'poland', 'polish', 'nato', 'netherlands', 'sweden', 'norway',
    'finland', 'greece', 'portugal', 'ireland', 'scotland', 'switzerland', 'austria',
  ],
  'MIDDLE EAST': [
    'israel', 'israeli', 'gaza', 'palestine', 'palestinian', 'hamas', 'hezbollah',
    'lebanon', 'iran', 'iranian', 'tehran', 'iraq', 'baghdad', 'syria', 'syrian',
    'saudi', 'riyadh', 'yemen', 'houthi', 'qatar', 'doha', 'dubai', 'abu dhabi',
    'turkey', 'turkish', 'ankara', 'jordan', 'egypt', 'cairo', 'jerusalem', 'tel aviv',
  ],
  'ASIA-PACIFIC': [
    'china', 'chinese', 'beijing', 'shanghai', 'taiwan', 'taipei', 'hong kong',
    'japan', 'japanese', 'tokyo', 'korea', 'korean', 'seoul', 'pyongyang',
    'india', 'indian', 'delhi', 'mumbai', 'pakistan', 'islamabad', 'bangladesh',
    'australia', 'australian', 'sydney', 'canberra', 'new zealand', 'indonesia',
    'philippines', 'vietnam', 'thailand', 'singapore', 'malaysia', 'myanmar', 'afghan',
  ],
  AFRICA: [
    'africa', 'african', 'nigeria', 'lagos', 'kenya', 'nairobi', 'ethiopia', 'sudan',
    'south africa', 'johannesburg', 'ghana', 'congo', 'somalia', 'mali', 'niger',
    'morocco', 'algeria', 'tunisia', 'libya', 'zimbabwe', 'uganda', 'rwanda', 'senegal',
  ],
  'LATIN AMERICA': [
    'brazil', 'brazilian', 'brasilia', 'argentina', 'buenos aires', 'chile', 'santiago',
    'colombia', 'bogota', 'venezuela', 'caracas', 'peru', 'lima', 'bolivia', 'ecuador',
    'cuba', 'havana', 'haiti', 'honduras', 'guatemala', 'panama', 'uruguay', 'paraguay',
    'mexico', 'mexican', 'nicaragua',
  ],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Plain substring matching false-positives constantly: "turkey" inside
// "Thanksgiving turkey", "mali" inside "normalize", "jordan" inside "Michael
// Jordan", "nato" inside "Chinatown". Word-boundary regex, one compile per
// keyword (module load, not per headline), fixes all of those.
const REGION_PATTERNS = Object.fromEntries(
  (Object.entries(REGION_KEYWORDS) as [Exclude<Region, 'GLOBAL'>, string[]][]).map(
    ([region, words]) => [region, words.map((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`, 'i'))],
  ),
) as Record<Exclude<Region, 'GLOBAL'>, RegExp[]>;

function detectRegion(text: string): Region {
  let best: Region = 'GLOBAL';
  let bestScore = 0;
  for (const [region, patterns] of Object.entries(REGION_PATTERNS) as [Exclude<Region, 'GLOBAL'>, RegExp[]][]) {
    let score = 0;
    for (const p of patterns) if (p.test(text)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = region;
    }
  }
  return best;
}

interface GNewsArticle {
  title: string;
  description: string;
  content: string;
  url: string;
  image: string | null;
  publishedAt: string;
  source: { name: string };
}

/**
 * Hacker News via the official Firebase API - completely free, no key, no
 * daily cap, and it works even when no GNews key is configured, so the feed
 * is never fully empty just because a paid-adjacent key is missing.
 */
async function fetchHackerNews(limit = 12): Promise<Article[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: ctrl.signal });
      if (!idsRes.ok) return [];
      const ids = (await idsRes.json()) as number[];

      const items = await Promise.all(
        ids.slice(0, limit).map(async (id) => {
          try {
            const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: ctrl.signal });
            if (!r.ok) return null;
            return (await r.json()) as {
              id: number; title?: string; url?: string; time?: number; by?: string; score?: number;
            };
          } catch {
            return null;
          }
        }),
      );

      return items
        .filter((it): it is NonNullable<typeof it> => Boolean(it?.title))
        .map((it) => ({
          id: it.url ?? `https://news.ycombinator.com/item?id=${it.id}`,
          title: it.title ?? '',
          description: it.score ? `${it.score} points on Hacker News` : '',
          content: '',
          url: it.url ?? `https://news.ycombinator.com/item?id=${it.id}`,
          image: null,
          publishedAt: it.time ? new Date(it.time * 1000).toISOString() : new Date().toISOString(),
          source: 'Hacker News',
          category: 'technology',
          region: detectRegion(it.title ?? '') as Region,
        }));
    } finally {
      clearTimeout(t);
    }
  } catch {
    return [];
  }
}

export function hasApiKey(): boolean {
  return Boolean(getSecret('GNEWS_API_KEY'));
}

export function quotaSnapshot() {
  const q = getQuota();
  return { used: q.used, cap: getSettings().news.dailyCap, date: q.date };
}

/**
 * Fetches one GNews request per configured category. Refuses to fire if doing so
 * would cross the daily cap - the free tier is the whole point, so we protect it.
 */
export async function fetchNews(manual = false): Promise<NewsResult> {
  const settings = getSettings();
  const key = getSecret('GNEWS_API_KEY');
  const cap = settings.news.dailyCap;

  const categories = settings.news.categories.length ? settings.news.categories : ['world'];
  const cost = categories.length;
  const q = getQuota();

  // Serve the disk cache when it is still fresh. Relaunching the app should not
  // cost requests for headlines we already fetched a few minutes ago.
  const cache = getNewsCache<Article>();
  const ageMinutes = (Date.now() - cache.fetchedAt) / 60000;
  if (!manual && cache.articles.length && ageMinutes < settings.news.autoRefreshMinutes) {
    return {
      articles: cache.articles,
      quota: quotaSnapshot(),
      fetchedAt: cache.fetchedAt,
      cached: true,
    };
  }

  // Hacker News costs nothing and needs no key, so the feed is never fully
  // empty just because GNews isn't configured or its quota is exhausted -
  // fetched unconditionally, merged into every return path below.
  const hnArticles = await fetchHackerNews();

  if (!key) {
    if (hnArticles.length) saveNewsCache(hnArticles);
    return {
      articles: hnArticles, quota: quotaSnapshot(), fetchedAt: Date.now(),
      error: hnArticles.length ? undefined : 'NO_API_KEY',
    };
  }

  if (q.used + cost > cap) {
    if (hnArticles.length) saveNewsCache(hnArticles);
    return {
      articles: hnArticles, quota: quotaSnapshot(), fetchedAt: Date.now(),
      error: `GNews daily cap reached (${q.used} of ${cap}) - showing Hacker News only until it resets at local midnight.`,
      blocked: true,
    };
  }
  // Leave headroom for manual refreshes: auto-refresh stops at 80% of the cap.
  if (!manual && q.used + cost > cap * 0.8) {
    if (hnArticles.length) saveNewsCache(hnArticles);
    return {
      articles: hnArticles, quota: quotaSnapshot(), fetchedAt: Date.now(),
      error: `Auto-refresh paused at 80% of the GNews daily cap (${q.used} of ${cap}) - showing Hacker News only. Manual refresh still available.`,
      blocked: true,
    };
  }

  // Reserve the full cost synchronously (read-modify-write, nothing awaited
  // in between) rather than bumping after each request completes. Bumping
  // only after the fact left a window where two concurrent fetches (an
  // auto-refresh timer firing alongside a manual click) could both pass the
  // cap check above before either had actually reserved anything.
  const reservation = reserveQuota(cost, cap);
  if (!reservation.ok) {
    if (hnArticles.length) saveNewsCache(hnArticles);
    return {
      articles: hnArticles, quota: quotaSnapshot(), fetchedAt: Date.now(),
      error: `GNews daily cap reached (${reservation.quota.used} of ${cap}) - showing Hacker News only until it resets at local midnight.`,
      blocked: true,
    };
  }

  const seen = new Set<string>();
  const articles: Article[] = [];
  let error: string | undefined;
  // Set when GNews refuses on auth grounds - retrying will not help.
  let authFailed = false;
  // Auth failures are rejected before GNews serves anything and should not
  // eat the reservation - counted here and given back at the end.
  let authFailedCount = 0;

  for (const [i, category] of categories.entries()) {
    // The free tier also caps requests per second - back-to-back category
    // requests got the second one refused as "too many requests in a short period".
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));
    const url = new URL('https://gnews.io/api/v4/top-headlines');
    url.searchParams.set('category', category);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('max', '10');
    if (settings.news.country && category === 'nation') {
      url.searchParams.set('country', settings.news.country);
    }
    url.searchParams.set('apikey', key);

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // GNews explains itself properly - pass its own words through rather
        // than guessing. "Bad key" and "unactivated account" are both 403.
        let detail = '';
        try {
          const parsed = JSON.parse(body) as { errors?: string[] | Record<string, string> };
          const errs = parsed.errors;
          detail = Array.isArray(errs) ? errs.join(' ') : errs ? Object.values(errs).join(' ') : '';
        } catch {
          detail = body.slice(0, 160);
        }

        if (res.status === 401 || res.status === 403) {
          error = detail || 'GNews refused the request. Check the GNews key in Settings.';
          authFailed = true;
          authFailedCount += 1;
        } else if (res.status === 429) {
          error = detail || 'GNews rate limit hit (429). Free tier is 100 requests per day.';
        } else {
          error = `GNews ${res.status}: ${detail}`;
        }
        continue;
      }

      const data = (await res.json()) as { articles?: GNewsArticle[] };
      for (const a of data.articles ?? []) {
        if (!a.url || seen.has(a.url)) continue;
        seen.add(a.url);
        articles.push({
          id: a.url,
          title: a.title ?? '',
          description: a.description ?? '',
          content: a.content ?? '',
          url: a.url,
          image: a.image ?? null,
          publishedAt: a.publishedAt ?? new Date().toISOString(),
          source: a.source?.name ?? 'unknown',
          category,
          region: detectRegion(`${a.title ?? ''} ${a.description ?? ''} ${a.source?.name ?? ''}`),
        });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Give back reservation for categories that failed before GNews served
  // anything - they should not eat the daily allowance.
  if (authFailedCount > 0) releaseQuota(authFailedCount);

  // Hacker News merges in alongside GNews rather than replacing it - two
  // genuinely different free sources (world/national news vs. tech), not one
  // pretending to be several.
  for (const a of hnArticles) if (!seen.has(a.id)) { seen.add(a.id); articles.push(a); }

  articles.sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));
  if (articles.length) saveNewsCache(articles);
  // Serve stale cache rather than an empty panel on any failure, not just
  // auth - a plain network timeout deserves the same fallback.
  if (!articles.length && error && cache.articles.length) {
    return { articles: cache.articles, quota: quotaSnapshot(), fetchedAt: cache.fetchedAt, error, blocked: true, cached: true };
  }
  return { articles, quota: quotaSnapshot(), fetchedAt: Date.now(), error, blocked: authFailed };
}
