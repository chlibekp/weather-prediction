import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries } from '../src/data/series.js';

const HOUR = 3600;

function block(times, temps) {
  return {
    time: times,
    temperature_2m: temps,
    relative_humidity_2m: temps.map((v) => (v == null ? null : 50)),
    surface_pressure: temps.map((v) => (v == null ? null : 1000)),
    wind_speed_10m: temps.map((v) => (v == null ? null : 5)),
    precipitation: temps.map(() => null),
  };
}

test('buildSeries interpolates gaps and masks them', () => {
  const s = buildSeries([block([0, HOUR, 2 * HOUR, 3 * HOUR], [10, null, null, 13])]);
  assert.deepEqual(Array.from(s.vars.temperature), [10, 11, 12, 13]);
  assert.deepEqual(Array.from(s.masks.temperature), [1, 0, 0, 1]);
  assert.deepEqual(Array.from(s.precip), [0, 0, 0, 0]);
});

test('later blocks fill hours earlier blocks left empty, earlier values win', () => {
  const archive = block([0, HOUR, 2 * HOUR], [1, 2, null]);
  const recent = block([HOUR, 2 * HOUR, 3 * HOUR], [99, 3, 4]);
  const s = buildSeries([archive, recent]);
  assert.deepEqual(Array.from(s.vars.temperature), [1, 2, 3, 4]);
});

test('hours after `until` are dropped', () => {
  const s = buildSeries([block([0, HOUR, 2 * HOUR], [1, 2, 3])], { until: HOUR * 1000 });
  assert.equal(s.times.length, 2);
});
