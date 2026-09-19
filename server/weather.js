/**
 * Optional weather strip for the TV view.
 *
 * Uses Open-Meteo, which needs no API key and no account, so a customer can
 * switch it on by dropping in coordinates. Failures are swallowed: a kitchen
 * calendar must never show an error page because a forecast timed out.
 */

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 6000;

// WMO weather interpretation codes, condensed to what fits on a TV tile.
const CONDITIONS = [
  [[0], 'clear', 'Clear'],
  [[1, 2], 'partly', 'Partly cloudy'],
  [[3], 'cloudy', 'Cloudy'],
  [[45, 48], 'fog', 'Fog'],
  [[51, 53, 55, 56, 57], 'drizzle', 'Drizzle'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'rain', 'Rain'],
  [[71, 73, 75, 77, 85, 86], 'snow', 'Snow'],
  [[95, 96, 99], 'storm', 'Thunderstorms'],
];

export function describeCode(code) {
  for (const [codes, icon, label] of CONDITIONS) {
    if (codes.includes(code)) return { icon, label };
  }
  return { icon: 'cloudy', label: 'Unsettled' };
}

/**
 * Turns "Leeds" into coordinates.
 *
 * Nobody knows their own latitude, and the browser's own location needs HTTPS
 * and a permission prompt — neither of which a television is going to give
 * you. Open-Meteo's geocoder is part of the same keyless service as the
 * forecast, so this costs nothing extra.
 */
export async function searchPlaces(query, fetchImpl = globalThis.fetch) {
  const name = typeof query === 'string' ? query.trim() : '';
  if (name.length < 2) return [];

  const url = new URL(GEOCODING);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '6');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.results || []).map((place) => ({
      name: place.name,
      // "Leeds, West Yorkshire, United Kingdom" — enough to tell apart the
      // several places that share a name.
      label: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      latitude: Number(place.latitude.toFixed(4)),
      longitude: Number(place.longitude.toFixed(4)),
      country: place.country_code || '',
    }));
  } catch {
    // A search that cannot reach the internet is an empty search, not an error
    // page in the middle of someone's settings.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export class WeatherService {
  #cache = null;
  #inFlight = null;

  constructor(fetchImpl = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  /** Returns a forecast, or null when weather is off or unreachable. */
  async get(settings, now = Date.now()) {
    const { enabled, latitude, longitude, unit, label } = settings.weather || {};
    if (!enabled || latitude === null || longitude === null) return null;

    const key = `${latitude},${longitude},${unit}`;
    if (this.#cache && this.#cache.key === key && now - this.#cache.at < CACHE_MS) {
      return this.#cache.value;
    }
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#load({ latitude, longitude, unit, label, key, now })
      .catch(() => this.#cache?.value ?? null)
      .finally(() => { this.#inFlight = null; });

    return this.#inFlight;
  }

  async #load({ latitude, longitude, unit, label, key, now }) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '4');
    url.searchParams.set('temperature_unit', unit === 'fahrenheit' ? 'fahrenheit' : 'celsius');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let payload;
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`weather responded ${response.status}`);
      payload = await response.json();
    } finally {
      clearTimeout(timer);
    }

    const value = shape(payload, { unit, label });
    this.#cache = { key, at: now, value };
    return value;
  }
}

function shape(payload, { unit, label }) {
  const current = payload?.current || {};
  const daily = payload?.daily || {};
  const days = (daily.time || []).map((date, index) => ({
    date,
    high: round(daily.temperature_2m_max?.[index]),
    low: round(daily.temperature_2m_min?.[index]),
    ...describeCode(daily.weather_code?.[index]),
  }));

  return {
    label,
    unit: unit === 'fahrenheit' ? '°F' : '°C',
    now: {
      temperature: round(current.temperature_2m),
      ...describeCode(current.weather_code),
    },
    days,
    fetchedAt: new Date().toISOString(),
  };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}
