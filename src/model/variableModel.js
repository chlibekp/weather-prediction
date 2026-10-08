// One variable = seasonal mean (regression) + SARIMA on the anomalies, with forecast
// intervals recalibrated on a validation window.
import { Z80, Z95, mean, quantile } from '../math/stats.js';
import { fitSeasonalMean, seasonalMean, HOUR_MS } from './seasonal.js';
import {
  describeOrder,
  fitSarima,
  forecastFrom,
  forecastSd,
  sarimaState,
} from './sarima.js';
import { TRANSFORMS, VARIABLES, clamp } from './variables.js';

export const HORIZON = 24;

// Kept outside the model object so the model stays plain JSON.
const sdCache = new WeakMap();

function leadSd(vm) {
  if (!sdCache.has(vm)) sdCache.set(vm, forecastSd(vm.sarima, HORIZON));
  return sdCache.get(vm);
}

export function anomalies(vm, times, values) {
  const { fwd } = TRANSFORMS[vm.transform];
  const z = new Float64Array(times.length);
  for (let t = 0; t < times.length; t++) z[t] = fwd(values[t]) - seasonalMean(vm.coef, times[t]);
  return z;
}

export function variableState(vm, times, values, mask) {
  return sarimaState(vm.sarima, anomalies(vm, times, values), mask);
}

// Validation origins every `step` hours inside [from, to) of a state built from index 0.
function validationErrors(model, state, z, mask, from, to, step = 3) {
  const sd = forecastSd(model, HORIZON);
  const absErr = Array.from({ length: HORIZON }, () => []);
  const ratios = Array.from({ length: HORIZON }, () => []);
  for (let o = from - 1; o + HORIZON < to; o += step) {
    const f = forecastFrom(model, state, o, HORIZON);
    for (let h = 0; h < HORIZON; h++) {
      if (!mask[o + 1 + h]) continue;
      const err = Math.abs(f[h] - z[o + 1 + h]);
      absErr[h].push(err);
      ratios[h].push(err / sd[h]);
    }
  }
  const score = mean(absErr.flat());
  return { score, ratios };
}

// Per-lead multiplier so that ±Z80·sd covers 80% of validation errors.
function calibrate(ratios) {
  const raw = ratios.map((r) => (r.length ? quantile(r, 0.8) / Z80 : 1));
  return raw.map((_, h) => {
    const window = raw.slice(Math.max(0, h - 2), h + 3);
    const s = mean(window);
    return Math.min(4, Math.max(0.5, s));
  });
}

export function fitVariable(name, series, { estStart, valStart, holdoutStart }, sarimaOpts = {}) {
  const cfg = VARIABLES[name];
  const { fwd } = TRANSFORMS[cfg.transform];
  const values = series.vars[name];
  const mask = series.masks[name];
  const x = Float64Array.from(values, fwd);
  const coef = fitSeasonalMean(series.times, x, mask, 0, valStart);
  const vm = { name, transform: cfg.transform, coef };
  const z = anomalies(vm, series.times, values);

  const zSeg = z.subarray(estStart, holdoutStart);
  const mSeg = mask.subarray(estStart, holdoutStart);
  const fitEnd = valStart - estStart;
  const candidates = [];
  for (const d of [0, 1]) {
    const model = fitSarima(zSeg.subarray(0, fitEnd), mSeg.subarray(0, fitEnd), d, sarimaOpts);
    const state = sarimaState(model, zSeg, mSeg);
    const { score } = validationErrors(model, state, zSeg, mSeg, fitEnd, zSeg.length);
    candidates.push({ model, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  const chosen = candidates[0];

  // Interval calibration uses origins spread over the whole year before the holdout, so the
  // widths reflect every season rather than just the two-week validation window. With only a
  // handful of parameters per model, in-sample errors are close to out-of-sample ones.
  const state = sarimaState(chosen.model, zSeg, mSeg);
  const { ratios } = validationErrors(chosen.model, state, zSeg, mSeg, 24 * 7, zSeg.length, 7);

  return {
    ...vm,
    sarima: chosen.model,
    order: describeOrder(chosen.model),
    scale: calibrate(ratios),
    validation: candidates.map((c) => ({ order: describeOrder(c.model), mae: c.score })),
  };
}

export function climatology(vm, t) {
  return TRANSFORMS[vm.transform].inv(seasonalMean(vm.coef, t));
}

// Forecast in original units with calibrated 80% / 95% intervals.
export function predictVariable(vm, times, state, o) {
  const { inv } = TRANSFORMS[vm.transform];
  const sdBase = leadSd(vm);
  const zf = forecastFrom(vm.sarima, state, o, HORIZON);
  const out = { mean: [], lo80: [], hi80: [], lo95: [], hi95: [] };
  for (let h = 0; h < HORIZON; h++) {
    const t = times[o] + (h + 1) * HOUR_MS;
    const center = zf[h] + seasonalMean(vm.coef, t);
    const sd = sdBase[h] * vm.scale[h];
    const at = (k) => clamp(vm.name, inv(center + k * sd));
    out.mean.push(at(0));
    out.lo80.push(at(-Z80));
    out.hi80.push(at(Z80));
    out.lo95.push(at(-Z95));
    out.hi95.push(at(Z95));
  }
  return out;
}
