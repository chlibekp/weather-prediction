// Orchestrates data fetching, model caching/training and forecast assembly per location.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildSeries } from './data/series.js';
import { MODEL_VERSION, forecastLocation } from './model/forecaster.js';
import { HOUR_MS } from './model/seasonal.js';
import { VARIABLES, VARIABLE_NAMES } from './model/variables.js';
import { describeOrder } from './model/sarima.js';

const HISTORY_DAYS = 730;
const RECENT_PAST_DAYS = 31;

export function trainInWorker(series, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./train-worker.js', import.meta.url), {
      workerData: { series, options },
    });
    worker.once('message', (msg) => (msg.ok ? resolve(msg.model) : reject(new Error(msg.error))));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Training worker exited with code ${code}`));
    });
  });
}

// Grid key: Open-Meteo data is ~10 km resolution, so 0.1° cells share one model.
export function locationKey(lat, lon) {
  return `${lat.toFixed(1)}_${lon.toFixed(1)}`;
}

export function createService({
  api,
  cacheDir,
  trainer = trainInWorker,
  maxModelAgeMs = 24 * HOUR_MS,
  recentTtlMs = 10 * 60_000,
  now = Date.now,
  log = console,
}) {
  const models = new Map();
  const training = new Map();
  const recentCache = new Map();

  const currentHour = () => Math.floor(now() / HOUR_MS) * HOUR_MS;
  const cachePath = (key) => path.join(cacheDir, `${key}.json`);

  async function readCached(key) {
    if (models.has(key)) return models.get(key);
    try {
      const model = JSON.parse(await fs.readFile(cachePath(key), 'utf8'));
      if (model.version !== MODEL_VERSION) return null;
      models.set(key, model);
      return model;
    } catch {
      return null;
    }
  }

  async function writeCached(key, model) {
    models.set(key, model);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath(key), JSON.stringify(model));
  }

  async function getRecent(key, lat, lon) {
    const hit = recentCache.get(key);
    if (hit && now() - hit.at < recentTtlMs) return hit.data;
    const data = await api.recent(lat, lon, RECENT_PAST_DAYS);
    recentCache.set(key, { at: now(), data });
    return data;
  }

  async function train(key, lat, lon) {
    const started = now();
    const [history, recent] = await Promise.all([api.history(lat, lon, HISTORY_DAYS), getRecent(key, lat, lon)]);
    const series = buildSeries([history, recent], { until: currentHour() });
    for (const w of series.warnings) log.warn(`[${key}] ${w}`);
    const model = await trainer(series);
    model.trainingMs = now() - started;
    await writeCached(key, model);
    log.info(`[${key}] trained in ${model.trainingMs} ms`);
    return model;
  }

  async function getModel(key, lat, lon) {
    const cached = await readCached(key);
    if (cached && now() - cached.trainedAt < maxModelAgeMs) return { model: cached, stale: false };
    if (!training.has(key)) {
      training.set(key, train(key, lat, lon).finally(() => training.delete(key)));
    }
    try {
      return { model: await training.get(key), stale: false };
    } catch (err) {
      if (cached) {
        log.warn(`[${key}] retraining failed, serving stale model: ${err.message}`);
        return { model: cached, stale: true };
      }
      throw err;
    }
  }

  function nwpFor(recent, times) {
    const index = new Map(recent.time.map((sec, i) => [sec * 1000, i]));
    const pick = (field) => times.map((t) => (index.has(t) ? recent[field]?.[index.get(t)] ?? null : null));
    const out = { precipitationProbability: pick('precipitation_probability') };
    for (const name of VARIABLE_NAMES) out[name] = pick(VARIABLES[name].api);
    return out;
  }

  function observed(series, hours) {
    const start = Math.max(0, series.times.length - hours);
    const out = { times: Array.from(series.times.subarray(start)) };
    for (const name of VARIABLE_NAMES) out[name] = Array.from(series.vars[name].subarray(start));
    out.precipitation = Array.from(series.precip.subarray(start));
    return out;
  }

  function summarizeModel(model, stale) {
    const variables = {};
    for (const name of VARIABLE_NAMES) {
      const v = model.variables[name];
      variables[name] = { order: describeOrder(v.sarima), sigma: Math.sqrt(v.sarima.sigma2), validation: v.validation };
    }
    return {
      trainedAt: model.trainedAt,
      trainingMs: model.trainingMs ?? null,
      history: model.history,
      stale,
      variables,
      rainSamples: model.rain.samples,
    };
  }

  return {
    async geocode(query) {
      return api.geocode(query);
    },

    async forecast({ latitude, longitude }) {
      const key = locationKey(latitude, longitude);
      const lat = Number(latitude.toFixed(1));
      const lon = Number(longitude.toFixed(1));
      const { model, stale } = await getModel(key, lat, lon);
      const recentHourly = await getRecent(key, lat, lon);
      const recent = buildSeries([recentHourly], { until: currentHour() });
      const fc = forecastLocation(model, recent);
      return {
        generatedAt: now(),
        origin: fc.origin,
        times: fc.times,
        forecast: { ...fc.variables, rainProbability: fc.rainProbability },
        nwp: nwpFor(recentHourly, fc.times),
        observed: observed(recent, 24),
        model: summarizeModel(model, stale),
        metrics: model.metrics,
        units: Object.fromEntries(VARIABLE_NAMES.map((n) => [n, VARIABLES[n].unit])),
      };
    },
  };
}
