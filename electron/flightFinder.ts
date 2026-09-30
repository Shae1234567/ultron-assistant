import { pageText } from './browser';

/** Real flight lookups via Google Flights - there is no free flight-price API
 *  without an account/key, so this drives the existing headless-Chromium
 *  module against the live search results page instead of fabricating data. */

export interface FlightResult { airline?: string; price?: string; duration?: string; stops?: string; raw: string }

const PRICE_RE = /\$\s?\d[\d,]*/;
const DURATION_RE = /\d+\s?hr\s?\d*\s?m(in)?/i;
const STOPS_RE = /\b(nonstop|direct|\d+\s?stop[s]?)\b/i;
// Airline names are free text with no reliable delimiter in plain body text,
// so this is a best-effort guess: the leading word-run before the first
// digit/price/duration token on the line, if any.
const AIRLINE_RE = /^([A-Za-z][A-Za-z .&'-]{1,30}?)(?=\s+(?:\$|\d+\s?hr))/;

export async function findFlights(
  origin: string,
  destination: string,
  date: string,
): Promise<{ ok: boolean; results: FlightResult[]; error?: string }> {
  try {
    const query = `Flights from ${origin} to ${destination} on ${date}`;
    const url = `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
    const page = await pageText(url);
    if (!page.ok) {
      return { ok: false, results: [], error: page.error || 'Failed to open Google Flights.' };
    }

    const text = page.text || '';
    // Google Flights' real DOM is heavily JS-rendered and restructures often,
    // and pageText only exposes visible body text (not markup), so this is
    // deliberately a best-effort regex scan over that text rather than a
    // structured scrape. Lines that look like they contain a price, duration,
    // or stop count are treated as candidate flight rows; the full line is
    // always kept as `raw` so nothing is lost even when the individual
    // fields below can't be parsed out of it.
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const results: FlightResult[] = [];

    for (const line of lines) {
      if (results.length >= 10) break;
      const hasPrice = PRICE_RE.test(line);
      const hasDuration = DURATION_RE.test(line);
      const hasStops = STOPS_RE.test(line);
      if (!hasPrice && !hasDuration && !hasStops) continue;

      const priceMatch = line.match(PRICE_RE);
      const durationMatch = line.match(DURATION_RE);
      const stopsMatch = line.match(STOPS_RE);
      const airlineMatch = line.match(AIRLINE_RE);

      results.push({
        airline: airlineMatch?.[1]?.trim(),
        price: priceMatch?.[0],
        duration: durationMatch?.[0],
        stops: stopsMatch?.[0],
        raw: line,
      });
    }

    // Empty results does NOT mean "no flights" - the page loaded fine, it
    // just didn't contain text this regex could parse (common given how
    // dynamic Google Flights' rendering is). Callers should tell the
    // operator to check Google Flights manually rather than claim there are
    // no available flights.
    return { ok: true, results };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, results: [], error: message };
  }
}
