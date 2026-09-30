/**
 * The Researcher specialist's real capability: querying several free,
 * no-key knowledge sources in parallel and handing the model verified
 * context instead of letting a small local model guess at facts.
 *
 * "Opens multiple research websites" literally, in two ways: the sources
 * below are queried concurrently (not one lookup pretending to be several),
 * and every result carries a real URL the renderer can open in the actual
 * browser via shell.openExternal - so the operator can go read the source
 * itself, not just trust a paraphrase.
 *
 * Every fetch is independently wrapped so one slow/dead source never blocks
 * or poisons the others - a source that fails just contributes nothing.
 */

export interface ResearchSource {
  source: 'Wikipedia' | 'Wikidata' | 'DuckDuckGo';
  title: string;
  summary: string;
  url: string;
}

const UA = 'Ultron-Desktop-Assistant/2.0 (personal desktop app)';
const TIMEOUT_MS = 8000;

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fromWikipedia(query: string): Promise<ResearchSource | null> {
  const searchUrl =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*' +
    `&srlimit=1&srsearch=${encodeURIComponent(query)}`;
  const searchData = (await fetchJson(searchUrl)) as { query?: { search?: { title?: string }[] } } | null;
  const title = searchData?.query?.search?.[0]?.title;
  if (!title) return null;

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const summaryData = (await fetchJson(summaryUrl)) as
    { title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } } | null;
  if (!summaryData?.extract) return null;

  return {
    source: 'Wikipedia',
    title: summaryData.title ?? title,
    summary: summaryData.extract,
    url: summaryData.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

async function fromWikidata(query: string): Promise<ResearchSource | null> {
  // Step 1: find the best matching entity.
  const searchUrl =
    'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*' +
    `&language=en&limit=1&search=${encodeURIComponent(query)}`;
  const searchData = (await fetchJson(searchUrl)) as
    { search?: { id?: string; label?: string; description?: string }[] } | null;
  const hit = searchData?.search?.[0];
  if (!hit?.id) return null;

  // Wikidata's search result already carries label + description, which is
  // exactly the structured-fact summary we want - no second round trip needed.
  return {
    source: 'Wikidata',
    title: hit.label ?? query,
    summary: hit.description ?? `Wikidata entity ${hit.id} - no description available.`,
    url: `https://www.wikidata.org/wiki/${hit.id}`,
  };
}

async function fromDuckDuckGo(query: string): Promise<ResearchSource | null> {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const data = (await fetchJson(url)) as
    { Heading?: string; AbstractText?: string; AbstractURL?: string } | null;
  if (!data?.AbstractText) return null;

  return {
    source: 'DuckDuckGo',
    title: data.Heading || query,
    summary: data.AbstractText,
    url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  };
}

/** Legacy single-source lookup, kept for the App.tsx dev capture hook. */
export async function lookupWikipedia(query: string): Promise<ResearchSource | null> {
  return fromWikipedia(query);
}

/**
 * Queries Wikipedia, Wikidata, and DuckDuckGo concurrently. Never throws -
 * an empty array means genuinely nothing was found, which the caller must
 * say plainly rather than papering over with an invented answer.
 */
export async function research(query: string): Promise<ResearchSource[]> {
  const q = query.trim();
  if (!q) return [];

  const settled = await Promise.allSettled([fromWikipedia(q), fromWikidata(q), fromDuckDuckGo(q)]);
  const results: ResearchSource[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) results.push(r.value);
  }
  return results;
}

/* ── Coach: live weather ────────────────────────────────────────────────
   Open-Meteo needs no API key at all. Geocode the operator's saved
   location once (cached), then pull current conditions - real numbers for
   training-day decisions, not a guess. */

let geocodeCache: { query: string; lat: number; lon: number; label: string } | null = null;

async function geocode(place: string): Promise<{ lat: number; lon: number; label: string } | null> {
  if (geocodeCache && geocodeCache.query === place) return geocodeCache;
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(place.split(',')[0])}`;
  const data = (await fetchJson(url)) as
    { results?: { latitude: number; longitude: number; name: string; admin1?: string; country?: string }[] } | null;
  const hit = data?.results?.[0];
  if (!hit) return null;
  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
  geocodeCache = { query: place, lat: hit.latitude, lon: hit.longitude, label };
  return geocodeCache;
}

const WEATHER_CODES: Record<number, string> = {
  0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'light snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

export interface WeatherResult {
  place: string;
  tempC: number;
  feelsLikeC: number;
  windKph: number;
  condition: string;
  isDay: boolean;
}

export async function getWeather(place: string): Promise<WeatherResult | null> {
  const loc = await geocode(place);
  if (!loc) return null;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    '&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code,is_day';
  const data = (await fetchJson(url)) as
    { current?: { temperature_2m?: number; apparent_temperature?: number; wind_speed_10m?: number; weather_code?: number; is_day?: number } } | null;
  const c = data?.current;
  if (!c || c.temperature_2m === undefined) return null;
  return {
    place: loc.label,
    tempC: Math.round(c.temperature_2m),
    feelsLikeC: Math.round(c.apparent_temperature ?? c.temperature_2m),
    windKph: Math.round(c.wind_speed_10m ?? 0),
    condition: WEATHER_CODES[c.weather_code ?? -1] ?? 'conditions unavailable',
    isDay: c.is_day !== 0,
  };
}

/* ── Historian: on this day ──────────────────────────────────────────── */

export interface OnThisDayEvent {
  year: string;
  text: string;
}

export async function getOnThisDay(): Promise<OnThisDayEvent[]> {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;
  const data = (await fetchJson(url)) as { events?: { year?: number; text?: string }[] } | null;
  const events = data?.events ?? [];
  // Bias toward older history over yesterday's routine news - matches the
  // operator's actual interest (empires, warfare) rather than recent trivia.
  return events
    .filter((e) => typeof e.year === 'number' && typeof e.text === 'string')
    .sort((a, b) => (a.year as number) - (b.year as number))
    .slice(0, 6)
    .map((e) => ({ year: String(e.year), text: e.text as string }));
}
