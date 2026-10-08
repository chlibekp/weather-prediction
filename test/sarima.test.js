import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitSarima,
  forecastFrom,
  forecastSd,
  isStationary,
  psiWeights,
  sarimaState,
  arPolynomial,
} from '../src/model/sarima.js';
import { gaussian, rng } from './helpers.js';

function simulate(n, { phi = [], Phi = 0, theta = 0, sigma = 1, seed = 1 }) {
  const rand = rng(seed);
  const z = new Float64Array(n);
  const e = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    e[t] = sigma * gaussian(rand);
    let v = e[t];
    phi.forEach((c, i) => {
      if (t - i - 1 >= 0) v += c * z[t - i - 1];
    });
    if (t >= 24) v += Phi * z[t - 24];
    if (t >= 25) phi.forEach((c, i) => (v -= c * Phi * z[t - 25 - i]));
    if (t >= 1) v += theta * e[t - 1];
    z[t] = v;
  }
  return z;
}

test('isStationary matches the AR(2) stationarity triangle', () => {
  assert.equal(isStationary([0.5]), true);
  assert.equal(isStationary([1.2]), false);
  assert.equal(isStationary([0.5, 0.3]), true);
  assert.equal(isStationary([0.5, 0.6]), false);
  assert.equal(isStationary([1.5, -0.6]), true);
});

test('arPolynomial expands the multiplicative seasonal operator', () => {
  const a = arPolynomial({ phi: [0.5], Phi: [0.4] });
  assert.equal(a.length, 26);
  assert.ok(Math.abs(a[1] + 0.5) < 1e-12);
  assert.ok(Math.abs(a[24] + 0.4) < 1e-12);
  assert.ok(Math.abs(a[25] - 0.2) < 1e-12);
});

test('psi weights of AR(1) are powers of phi', () => {
  const psi = psiWeights({ phi: [0.7], Phi: [], theta: [], Theta: [], d: 0 }, 5);
  for (let j = 0; j < 5; j++) assert.ok(Math.abs(psi[j] - 0.7 ** j) < 1e-12);
});

test('fitSarima recovers a seasonal AR process', () => {
  const z = simulate(6000, { phi: [0.8], Phi: 0.5, seed: 7 });
  const mask = new Uint8Array(z.length).fill(1);
  const model = fitSarima(z, mask, 0);
  assert.ok(model.p >= 1 && model.P === 1, `picked ${JSON.stringify(model)}`);
  assert.ok(Math.abs(model.phi[0] - 0.8) < 0.08, `phi ${model.phi}`);
  assert.ok(Math.abs(model.Phi[0] - 0.5) < 0.08, `Phi ${model.Phi}`);
  assert.ok(Math.abs(model.sigma2 - 1) < 0.1, `sigma2 ${model.sigma2}`);
});

test('fitSarima recovers ARMA(1,1)', () => {
  const z = simulate(6000, { phi: [0.6], theta: 0.4, seed: 3 });
  const mask = new Uint8Array(z.length).fill(1);
  const model = fitSarima(z, mask, 0, { maxSP: 0, maxSQ: 0 });
  assert.equal(model.p, 1);
  assert.equal(model.q, 1);
  assert.ok(Math.abs(model.phi[0] - 0.6) < 0.08);
  assert.ok(Math.abs(model.theta[0] - 0.4) < 0.08);
});

test('forecasts decay toward the mean and intervals widen', () => {
  const model = { d: 0, mu: 0, phi: [0.9], Phi: [], theta: [], Theta: [], sigma2: 1 };
  const z = new Float64Array(50).fill(0);
  z[49] = 10;
  const mask = new Uint8Array(50).fill(1);
  const state = sarimaState(model, z, mask);
  const f = forecastFrom(model, state, 49, 3);
  assert.ok(Math.abs(f[0] - 9) < 1e-9);
  assert.ok(Math.abs(f[2] - 10 * 0.9 ** 3) < 1e-9);
  const sd = forecastSd(model, 3);
  assert.ok(sd[0] < sd[1] && sd[1] < sd[2]);
  assert.ok(Math.abs(sd[0] - 1) < 1e-12);
});

test('d=1 forecasts integrate from the last level', () => {
  const model = { d: 1, mu: 0, phi: [0.5], Phi: [], theta: [], Theta: [], sigma2: 1 };
  const z = Float64Array.from({ length: 30 }, (_, t) => t);
  const mask = new Uint8Array(30).fill(1);
  const state = sarimaState(model, z, mask);
  const f = forecastFrom(model, state, 29, 2);
  assert.ok(Math.abs(f[0] - 29.5) < 1e-9);
  assert.ok(Math.abs(f[1] - 29.75) < 1e-9);
});
