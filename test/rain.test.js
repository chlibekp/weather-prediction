import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLogistic, predictLogistic } from '../src/model/rain.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('fitLogistic recovers known coefficients', () => {
  const rand = rng(11);
  const X = [];
  const y = [];
  for (let i = 0; i < 20000; i++) {
    const a = rand() * 4 - 2;
    const b = rand() * 4 - 2;
    const p = 1 / (1 + Math.exp(-(-1 + 2 * a - 1 * b)));
    X.push([a, b]);
    y.push(rand() < p ? 1 : 0);
  }
  const model = fitLogistic(X, y, { lambda: 0 });
  // beta is on the standardized scale; compare predictions instead.
  for (const [a, b] of [[0, 0], [1, -1], [-1.5, 0.5]]) {
    const truth = 1 / (1 + Math.exp(-(-1 + 2 * a - 1 * b)));
    assert.ok(Math.abs(predictLogistic(model, [a, b]) - truth) < 0.03);
  }
});

test('fitLogistic stays finite on rare, nearly separable events', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 5000; i++) {
    const x = i / 5000;
    X.push([x, x ** 4, i % 7 === 0 ? 1e3 : 0]);
    y.push(x > 0.995 ? 1 : 0);
  }
  const model = fitLogistic(X, y, { lambda: 1 });
  for (const b of model.beta) assert.ok(Number.isFinite(b) && Math.abs(b) < 100);
  assert.ok(predictLogistic(model, [0.999, 0.996, 0]) > 0.1);
  assert.ok(predictLogistic(model, [0.1, 0.0001, 0]) < 0.01);
});
