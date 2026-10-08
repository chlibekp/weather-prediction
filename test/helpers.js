import { VARIABLES, VARIABLE_NAMES } from '../src/model/variables.js';

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

// Synthetic Open-Meteo `hourly` block: seasonal + diurnal cycles plus AR(1) weather noise,
// with rain more likely when humidity is high.
export function syntheticHourly({ days, start = Date.UTC(2024, 0, 1), seed = 1 }) {
  const rand = rng(seed);
  const n = days * 24;
  const hourly = { time: [] };
  for (const f of [...VARIABLE_NAMES.map((v) => VARIABLES[v].api), 'precipitation']) hourly[f] = [];
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const t = start + i * 3600_000;
    const day = (2 * Math.PI * (t % 86_400_000)) / 86_400_000;
    const year = (2 * Math.PI * t) / (365.2425 * 86_400_000);
    a = 0.95 * a + 0.6 * gaussian(rand);
    b = 0.97 * b + 0.5 * gaussian(rand);
    c = 0.9 * c + 0.3 * gaussian(rand);
    const temp = 10 - 8 * Math.cos(year) - 4 * Math.cos(day) + a;
    const hum = Math.min(100, Math.max(5, 70 + 15 * Math.cos(day) - 3 * a + 8 * c));
    hourly.time.push(t / 1000);
    hourly.temperature_2m.push(Number(temp.toFixed(1)));
    hourly.relative_humidity_2m.push(Math.round(hum));
    hourly.surface_pressure.push(Number((1000 + 3 * b).toFixed(1)));
    hourly.wind_speed_10m.push(Number(Math.max(0, 10 + 3 * Math.sin(day) + 2 * c).toFixed(1)));
    hourly.precipitation.push(hum > 88 && rand() < 0.6 ? 0.4 : 0);
  }
  return hourly;
}
