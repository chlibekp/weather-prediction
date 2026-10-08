// Thin Open-Meteo client: geocoding, historical archive, and recent hours + NWP forecast.
import { PRECIP_FIELD, VARIABLES, VARIABLE_NAMES } from '../model/variables.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
// Archived runs of the same models the forecast API serves, so history and recent hours agree.
// (ERA5 reanalysis differs by several % humidity and ~2 km/h wind, which would bias anomalies.)
const HISTORY_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

export const HOURLY_FIELDS = [...VARIABLE_NAMES.map((n) => VARIABLES[n].api), PRECIP_FIELD];

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createOpenMeteo({ fetch = globalThis.fetch, timeoutMs = 30_000, now = Date.now } = {}) {
  async function getJson(base, params) {
    const url = `${base}?${new URLSearchParams(params)}`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new UpstreamError(`Open-Meteo unreachable: ${err.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new UpstreamError(`Open-Meteo responded ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    async geocode(query, count = 8) {
      const data = await getJson(GEOCODE_URL, { name: query, count, language: 'en', format: 'json' });
      return (data.results ?? []).map((r) => ({
        name: r.name,
        admin1: r.admin1 ?? null,
        country: r.country ?? r.country_code ?? '',
        countryCode: r.country_code ?? '',
        latitude: r.latitude,
        longitude: r.longitude,
        timezone: r.timezone ?? 'UTC',
        population: r.population ?? null,
      }));
    },

    // Hourly history up to today; hours after now are forecasts and get trimmed by the caller.
    async history(lat, lon, days) {
      const end = now();
      const data = await getJson(HISTORY_URL, {
        latitude: lat,
        longitude: lon,
        start_date: isoDate(end - days * 24 * 3600_000),
        end_date: isoDate(end),
        hourly: HOURLY_FIELDS.join(','),
        timeformat: 'unixtime',
        timezone: 'GMT',
      });
      return data.hourly;
    },

    // Recent hours (analysis) plus the operational NWP forecast for comparison.
    async recent(lat, lon, pastDays) {
      const data = await getJson(FORECAST_URL, {
        latitude: lat,
        longitude: lon,
        past_days: pastDays,
        forecast_days: 2,
        hourly: [...HOURLY_FIELDS, 'precipitation_probability'].join(','),
        timeformat: 'unixtime',
        timezone: 'GMT',
      });
      return data.hourly;
    },
  };
}
