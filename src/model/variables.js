// Forecast targets and how they map to Open-Meteo hourly fields.
export const VARIABLES = {
  temperature: { api: 'temperature_2m', label: 'Temperature', unit: '°C', transform: 'none' },
  humidity: { api: 'relative_humidity_2m', label: 'Humidity', unit: '%', transform: 'logit', min: 0, max: 100 },
  pressure: { api: 'surface_pressure', label: 'Pressure', unit: 'hPa', transform: 'none' },
  windSpeed: { api: 'wind_speed_10m', label: 'Wind speed', unit: 'km/h', transform: 'sqrt', min: 0 },
};

export const VARIABLE_NAMES = Object.keys(VARIABLES);

export const PRECIP_FIELD = 'precipitation';
export const WET_THRESHOLD_MM = 0.1;

// Wind speed is modeled on the square-root scale to stabilize its variance, and humidity on
// the logit scale so forecasts and ranges approach 0–100% smoothly instead of being clipped.
// The inverse of a forecast on a transformed scale is the median, not the mean.
// Softened logit: the offset keeps saturated (100%) hours from producing extreme values.
const SOFT = 10;
const logit = (pct) => {
  const h = Math.min(100, Math.max(0, pct));
  return Math.log((h + SOFT) / (100 + SOFT - h));
};
const expit = (x) => {
  const e = Math.exp(x);
  return (e * (100 + SOFT) - SOFT) / (1 + e);
};

export const TRANSFORMS = {
  none: { fwd: (v) => v, inv: (v) => v },
  sqrt: { fwd: (v) => Math.sqrt(Math.max(v, 0)), inv: (v) => (v < 0 ? 0 : v * v) },
  logit: { fwd: logit, inv: expit },
};

export function clamp(name, v) {
  const { min = -Infinity, max = Infinity } = VARIABLES[name];
  return Math.min(max, Math.max(min, v));
}
