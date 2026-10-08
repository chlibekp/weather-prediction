// Trains every per-variable model and the rain model for a location, backtests them on a
// held-out window, and produces 24-hour forecasts from the latest observation.
//
// Timeline of the training series (oldest → newest):
//   [ seasonal-mean only | SARIMA estimation | validation (d choice, intervals) | holdout (backtest) ]
import { HOUR_MS } from './seasonal.js';
import { fitLogistic, predictLogistic, rainFeatures } from './rain.js';
import { HORIZON, climatology, fitVariable, predictVariable, variableState } from './variableModel.js';
import { VARIABLE_NAMES, WET_THRESHOLD_MM } from './variables.js';

export const MODEL_VERSION = 2;

const DEFAULTS = {
  holdoutDays: 30,
  validationDays: 14,
  estimationDays: 365,
  rainOriginStep: 5,
  backtestOriginStep: 12,
};

export function sliceSeries(series, start, end) {
  const vars = {};
  const masks = {};
  for (const name of VARIABLE_NAMES) {
    vars[name] = series.vars[name].subarray(start, end);
    masks[name] = series.masks[name].subarray(start, end);
  }
  return {
    times: series.times.subarray(start, end),
    vars,
    masks,
    precip: series.precip.subarray(start, end),
  };
}

function buildStates(variables, seg) {
  const states = {};
  for (const name of VARIABLE_NAMES) {
    states[name] = variableState(variables[name], seg.times, seg.vars[name], seg.masks[name]);
  }
  return states;
}

function forecastAll(variables, seg, states, o) {
  const out = {};
  for (const name of VARIABLE_NAMES) out[name] = predictVariable(variables[name], seg.times, states[name], o);
  return out;
}

const isWet = (mm) => (mm >= WET_THRESHOLD_MM ? 1 : 0);

function rainRows(variables, seg, fcs, o) {
  const wet0 = isWet(seg.precip[o]);
  let wet6 = 0;
  for (let k = 0; k < 6; k++) wet6 += isWet(seg.precip[Math.max(0, o - k)]) / 6;
  const pressureAt = (h) => (h <= 0 ? seg.vars.pressure[o + h] : fcs.pressure.mean[h - 1]);
  const rows = [];
  for (let h = 1; h <= HORIZON; h++) {
    const t = seg.times[o] + h * HOUR_MS;
    rows.push(
      rainFeatures({
        t,
        h,
        humidity: fcs.humidity.mean[h - 1],
        pressureTendency: pressureAt(h) - pressureAt(h - 3),
        windSpeed: fcs.windSpeed.mean[h - 1],
        tempAnomaly: fcs.temperature.mean[h - 1] - climatology(variables.temperature, t),
        wet0,
        wet6,
      }),
    );
  }
  return rows;
}

function monthOf(t) {
  return new Date(t).getUTCMonth();
}

function trainRain(variables, seg, states, end, step) {
  const X = [];
  const y = [];
  for (let o = 48; o + HORIZON < end; o += step) {
    const rows = rainRows(variables, seg, forecastAll(variables, seg, states, o), o);
    rows.forEach((row, i) => {
      X.push(row);
      y.push(isWet(seg.precip[o + 1 + i]));
    });
  }
  const wet = new Array(12).fill(0);
  const total = new Array(12).fill(0);
  for (let t = 0; t < end; t++) {
    const m = monthOf(seg.times[t]);
    wet[m] += isWet(seg.precip[t]);
    total[m]++;
  }
  const overall = wet.reduce((a, b) => a + b, 0) / Math.max(1, total.reduce((a, b) => a + b, 0));
  return {
    logistic: fitLogistic(X, y, { lambda: 1 }),
    baseRateByMonth: wet.map((w, m) => (total[m] > 24 * 7 ? w / total[m] : overall)),
    samples: X.length,
  };
}

function backtest(variables, rain, seg, states, start, step) {
  const n = seg.times.length;
  const zeros = () => new Array(HORIZON).fill(0);
  const acc = {};
  for (const name of VARIABLE_NAMES) {
    acc[name] = { model: zeros(), persistence: zeros(), climatology: zeros(), count: zeros(), in80: 0, in95: 0, total: 0 };
  }
  const bins = Array.from({ length: 10 }, () => ({ sumP: 0, wet: 0, n: 0 }));
  let brier = 0;
  let brierClim = 0;
  let rainN = 0;
  let origins = 0;

  for (let o = start - 1; o + HORIZON < n; o += step) {
    origins++;
    const fcs = forecastAll(variables, seg, states, o);
    for (const name of VARIABLE_NAMES) {
      const a = acc[name];
      const obs = seg.vars[name];
      const mask = seg.masks[name];
      for (let h = 0; h < HORIZON; h++) {
        const t = o + 1 + h;
        if (!mask[t]) continue;
        const f = fcs[name];
        a.model[h] += Math.abs(f.mean[h] - obs[t]);
        a.persistence[h] += Math.abs(obs[o] - obs[t]);
        a.climatology[h] += Math.abs(climatology(variables[name], seg.times[t]) - obs[t]);
        a.count[h]++;
        a.in80 += obs[t] >= f.lo80[h] && obs[t] <= f.hi80[h] ? 1 : 0;
        a.in95 += obs[t] >= f.lo95[h] && obs[t] <= f.hi95[h] ? 1 : 0;
        a.total++;
      }
    }
    rainRows(variables, seg, fcs, o).forEach((row, h) => {
      const t = o + 1 + h;
      const p = predictLogistic(rain.logistic, row);
      const actual = isWet(seg.precip[t]);
      const pc = rain.baseRateByMonth[monthOf(seg.times[t])];
      brier += (p - actual) ** 2;
      brierClim += (pc - actual) ** 2;
      rainN++;
      const bin = bins[Math.min(9, Math.floor(p * 10))];
      bin.sumP += p;
      bin.wet += actual;
      bin.n++;
    });
  }

  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const metrics = { origins, from: seg.times[start], to: seg.times[n - 1], variables: {} };
  for (const name of VARIABLE_NAMES) {
    const a = acc[name];
    const per = (arr) => arr.map((v, h) => v / Math.max(1, a.count[h]));
    const model = per(a.model);
    const persistence = per(a.persistence);
    const clim = per(a.climatology);
    metrics.variables[name] = {
      mae: model,
      maePersistence: persistence,
      maeClimatology: clim,
      meanMae: avg(model),
      skillVsPersistence: 1 - avg(model) / avg(persistence),
      skillVsClimatology: 1 - avg(model) / avg(clim),
      coverage80: a.in80 / Math.max(1, a.total),
      coverage95: a.in95 / Math.max(1, a.total),
    };
  }
  metrics.rain = {
    brier: brier / rainN,
    brierClimatology: brierClim / rainN,
    brierSkill: 1 - brier / brierClim,
    reliability: bins
      .filter((b) => b.n > 0)
      .map((b) => ({ forecast: b.sumP / b.n, observed: b.wet / b.n, n: b.n })),
  };
  return metrics;
}

export function trainLocation(series, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const n = series.times.length;
  const holdoutStart = n - opts.holdoutDays * 24;
  const valStart = holdoutStart - opts.validationDays * 24;
  const estStart = Math.max(0, valStart - opts.estimationDays * 24);
  if (valStart - estStart < 60 * 24) throw new Error('Not enough history to train (need ~4 months)');

  const variables = {};
  for (const name of VARIABLE_NAMES) {
    variables[name] = fitVariable(name, series, { estStart, valStart, holdoutStart }, opts.sarima);
  }

  const seg = sliceSeries(series, estStart, n);
  const states = buildStates(variables, seg);
  const rain = trainRain(variables, seg, states, holdoutStart - estStart, opts.rainOriginStep);
  const metrics = backtest(variables, rain, seg, states, holdoutStart - estStart, opts.backtestOriginStep);

  return {
    version: MODEL_VERSION,
    trainedAt: Date.now(),
    history: { from: series.times[0], to: series.times[n - 1], hours: n },
    variables,
    rain,
    metrics,
  };
}

// `recent` must end at the forecast origin (the latest observed hour).
export function forecastLocation(trained, recent) {
  const states = buildStates(trained.variables, recent);
  const o = recent.times.length - 1;
  const fcs = forecastAll(trained.variables, recent, states, o);
  const rainProbability = rainRows(trained.variables, recent, fcs, o).map((row) =>
    predictLogistic(trained.rain.logistic, row),
  );
  const times = Array.from({ length: HORIZON }, (_, h) => recent.times[o] + (h + 1) * HOUR_MS);
  return { origin: recent.times[o], times, variables: fcs, rainProbability };
}
