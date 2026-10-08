// Turns Open-Meteo hourly blocks into a regular hourly series with gap masks.
import { HOUR_MS } from '../model/seasonal.js';
import { PRECIP_FIELD, VARIABLES, VARIABLE_NAMES } from '../model/variables.js';

// Linear interpolation over NaNs (flat at the edges). Returns the observation mask.
function fillGaps(values) {
  const n = values.length;
  const mask = new Uint8Array(n);
  let last = -1;
  for (let t = 0; t < n; t++) {
    if (Number.isNaN(values[t])) continue;
    mask[t] = 1;
    if (last === -1) {
      for (let k = 0; k < t; k++) values[k] = values[t];
    } else if (t - last > 1) {
      const step = (values[t] - values[last]) / (t - last);
      for (let k = last + 1; k < t; k++) values[k] = values[last] + step * (k - last);
    }
    last = t;
  }
  if (last === -1) return null;
  for (let k = last + 1; k < n; k++) values[k] = values[last];
  return mask;
}

// `blocks` are Open-Meteo `hourly` objects fetched with timeformat=unixtime, oldest source
// first; later blocks only fill hours the earlier ones left empty. Hours after `until` are dropped.
export function buildSeries(blocks, { until = Infinity, gapWarningHours = 72 } = {}) {
  const fields = [...VARIABLE_NAMES.map((n) => VARIABLES[n].api), PRECIP_FIELD];
  const rows = new Map();
  for (const block of blocks) {
    block.time.forEach((sec, i) => {
      const t = sec * 1000;
      if (t > until) return;
      const row = rows.get(t) ?? {};
      for (const f of fields) {
        const v = block[f]?.[i];
        if (row[f] == null && v != null) row[f] = v;
      }
      rows.set(t, row);
    });
  }
  if (rows.size === 0) throw new Error('No hourly data returned');

  const keys = [...rows.keys()];
  const first = Math.min(...keys);
  // Drop trailing hours where nothing has been observed yet.
  let last = first;
  for (const [t, row] of rows) {
    if (t > last && fields.some((f) => row[f] != null)) last = t;
  }
  const n = Math.round((last - first) / HOUR_MS) + 1;
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) times[i] = first + i * HOUR_MS;

  const vars = {};
  const masks = {};
  const warnings = [];
  for (const name of VARIABLE_NAMES) {
    const f = VARIABLES[name].api;
    const values = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const v = rows.get(times[i])?.[f];
      if (v != null) values[i] = v;
    }
    const mask = fillGaps(values);
    if (!mask) throw new Error(`No data for ${name}`);
    const missing = mask.length - mask.reduce((a, b) => a + b, 0);
    if (missing > gapWarningHours) warnings.push(`${name}: ${missing} missing hours interpolated`);
    vars[name] = values;
    masks[name] = mask;
  }
  const precip = new Float64Array(n);
  for (let i = 0; i < n; i++) precip[i] = rows.get(times[i])?.[PRECIP_FIELD] ?? 0;

  return { times, vars, masks, precip, warnings };
}
