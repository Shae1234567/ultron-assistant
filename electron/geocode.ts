/**
 * Geocoding via OpenStreetMap's Nominatim (https://nominatim.org).
 *
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * requires a real, identifying User-Agent on every request (generic or missing
 * User-Agent headers get blocked), and asks for no more than ~1 request per
 * second. It's free for reasonable personal use, not for high-volume production
 * traffic. That's why distanceToPlace() geocodes sequentially (await, one after
 * the other) instead of firing both lookups in parallel with Promise.all - a
 * simple, natural way to stay well within the fair-use rate limit.
 */

const NOMINATIM_USER_AGENT = 'Ultron-Desktop-Assistant/2.0 (personal desktop app)';

export interface GeoPlace {
  name: string;
  lat: number;
  lon: number;
  displayName: string;
}

export async function geocodePlace(
  query: string
): Promise<{ ok: boolean; place?: GeoPlace; error?: string }> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      query
    )}&format=json&limit=1`;

    const response = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
    });

    if (!response.ok) {
      return { ok: false, error: `Nominatim request failed: ${response.status} ${response.statusText}` };
    }

    const results = (await response.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;

    if (!results || results.length === 0) {
      return { ok: false, error: `No location found for "${query}".` };
    }

    const first = results[0];
    const place: GeoPlace = {
      name: query,
      lat: Number(first.lat),
      lon: Number(first.lon),
      displayName: first.display_name,
    };

    return { ok: true, place };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function distanceBetweenKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const EARTH_RADIUS_KM = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  const distanceKm = EARTH_RADIUS_KM * c;

  return Math.round(distanceKm * 10) / 10;
}

export async function distanceToPlace(
  fromPlace: string,
  toPlace: string
): Promise<{ ok: boolean; from?: GeoPlace; to?: GeoPlace; distanceKm?: number; error?: string }> {
  try {
    // Sequential, not Promise.all - see file header re: Nominatim's ~1 req/sec policy.
    const fromResult = await geocodePlace(fromPlace);
    if (!fromResult.ok || !fromResult.place) {
      return { ok: false, error: fromResult.error ?? `No location found for "${fromPlace}".` };
    }

    const toResult = await geocodePlace(toPlace);
    if (!toResult.ok || !toResult.place) {
      return { ok: false, error: toResult.error ?? `No location found for "${toPlace}".` };
    }

    const distanceKm = distanceBetweenKm(fromResult.place, toResult.place);

    return { ok: true, from: fromResult.place, to: toResult.place, distanceKm };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
