// Deterministic seasonal mean: annual + diurnal Fourier harmonics and their interaction,
// so the daily cycle can be larger in summer than in winter. Times are UTC milliseconds;
// the diurnal cycle follows the sun, which is fixed relative to UTC at a given longitude.
import { Gram } from '../math/linalg.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const YEAR_MS = 365.2425 * DAY_MS;

export function dayPhase(t) {
  return (2 * Math.PI * (((t % DAY_MS) + DAY_MS) % DAY_MS)) / DAY_MS;
}

export function yearPhase(t) {
  return (2 * Math.PI * t) / YEAR_MS;
}

export function seasonalFeatures(t) {
  const h = dayPhase(t);
  const d = yearPhase(t);
  const sh = Math.sin(h);
  const ch = Math.cos(h);
  const sd = Math.sin(d);
  const cd = Math.cos(d);
  return [
    1,
    sd, cd, Math.sin(2 * d), Math.cos(2 * d),
    sh, ch, Math.sin(2 * h), Math.cos(2 * h), Math.sin(3 * h), Math.cos(3 * h),
    sh * sd, sh * cd, ch * sd, ch * cd,
  ];
}

export function fitSeasonalMean(times, values, mask, start = 0, end = times.length) {
  const g = new Gram(seasonalFeatures(0).length);
  for (let t = start; t < end; t++) {
    if (mask[t]) g.add(seasonalFeatures(times[t]), values[t]);
  }
  if (g.n < 24 * 30) throw new Error('Not enough history to fit the seasonal mean');
  return g.solve(1e-9, [0]);
}

export function seasonalMean(coef, t) {
  const f = seasonalFeatures(t);
  let s = 0;
  for (let i = 0; i < coef.length; i++) s += coef[i] * f[i];
  return s;
}
