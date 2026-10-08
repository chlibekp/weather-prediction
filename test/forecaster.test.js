import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries } from '../src/data/series.js';
import { forecastLocation, trainLocation } from '../src/model/forecaster.js';
import { syntheticHourly } from './helpers.js';

test('trains on synthetic history, beats persistence, and forecasts 24 sane hours', () => {
  const series = buildSeries([syntheticHourly({ days: 220, seed: 5 })]);
  const model = trainLocation(series, { estimationDays: 120, sarima: { candidates: 2 } });

  // The model must survive a JSON round trip (it is cached on disk).
  const trained = JSON.parse(JSON.stringify(model));
  const temp = trained.metrics.variables.temperature;
  assert.equal(temp.mae.length, 24);
  assert.ok(temp.skillVsPersistence > 0.2, `skill ${temp.skillVsPersistence}`);
  assert.ok(temp.coverage80 > 0.6 && temp.coverage80 < 0.95, `coverage ${temp.coverage80}`);
  assert.ok(trained.metrics.rain.brierSkill > 0, `brier skill ${trained.metrics.rain.brierSkill}`);

  const recent = buildSeries([syntheticHourly({ days: 31, start: Date.UTC(2024, 7, 9), seed: 9 })]);
  const fc = forecastLocation(trained, recent);
  assert.equal(fc.times.length, 24);
  assert.equal(fc.times[0] - fc.origin, 3600_000);
  for (const name of ['temperature', 'humidity', 'pressure', 'windSpeed']) {
    const v = fc.variables[name];
    for (let h = 0; h < 24; h++) {
      assert.ok(Number.isFinite(v.mean[h]), `${name} mean`);
      assert.ok(v.lo95[h] <= v.lo80[h] && v.lo80[h] <= v.mean[h] && v.mean[h] <= v.hi80[h] && v.hi80[h] <= v.hi95[h]);
    }
  }
  for (const v of fc.variables.humidity.hi95) assert.ok(v <= 100);
  for (const v of fc.variables.windSpeed.lo95) assert.ok(v >= 0);
  for (const p of fc.rainProbability) assert.ok(p >= 0 && p <= 1);
});
