// Probability of measurable precipitation in an hour, from SARIMA forecasts of the other
// variables plus recent rain at the forecast origin. L2-regularized logistic regression (IRLS).
import { solveRidge } from '../math/linalg.js';
import { sigmoid } from '../math/stats.js';
import { dayPhase, yearPhase } from './seasonal.js';

export function rainFeatures({ t, h, humidity, pressureTendency, windSpeed, tempAnomaly, wet0, wet6 }) {
  const hr = dayPhase(t);
  const yr = yearPhase(t);
  const rh = humidity / 100;
  return [
    rh,
    rh ** 4,
    pressureTendency,
    Math.sqrt(Math.max(windSpeed, 0)),
    tempAnomaly,
    Math.sin(hr),
    Math.cos(hr),
    Math.sin(yr),
    Math.cos(yr),
    wet0,
    wet6,
    wet0 * Math.exp(-h / 3),
    wet6 * Math.exp(-h / 12),
    h / 24,
  ];
}

export function fitLogistic(X, y, { lambda = 1, maxIter = 30 } = {}) {
  const n = X.length;
  const k = X[0].length;
  const mu = new Array(k).fill(0);
  const sd = new Array(k).fill(0);
  for (const row of X) for (let j = 0; j < k; j++) mu[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < k; j++) sd[j] += (row[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j]) || 1;

  const dim = k + 1;
  const Z = X.map((row) => {
    const z = new Float64Array(dim);
    z[0] = 1;
    for (let j = 0; j < k; j++) z[j + 1] = (row[j] - mu[j]) / sd[j];
    return z;
  });
  const objective = (b) => {
    let ll = 0;
    for (let i = 0; i < n; i++) {
      let eta = 0;
      for (let j = 0; j < dim; j++) eta += b[j] * Z[i][j];
      // log(1 + e^eta) computed stably
      const softplus = eta > 0 ? eta + Math.log1p(Math.exp(-eta)) : Math.log1p(Math.exp(eta));
      ll += y[i] * eta - softplus;
    }
    let penalty = 0;
    for (let j = 1; j < dim; j++) penalty += b[j] * b[j];
    return ll - (lambda / 2) * penalty;
  };

  let beta = new Array(dim).fill(0);
  const base = y.reduce((a, b) => a + b, 0) / n;
  beta[0] = Math.log((base + 1e-6) / (1 - base + 1e-6));
  let current = objective(beta);
  for (let iter = 0; iter < maxIter; iter++) {
    const Hm = Array.from({ length: dim }, () => new Float64Array(dim));
    const grad = new Array(dim).fill(0);
    for (let i = 0; i < n; i++) {
      const xs = Z[i];
      let eta = 0;
      for (let j = 0; j < dim; j++) eta += beta[j] * xs[j];
      const p = sigmoid(eta);
      const wgt = Math.max(p * (1 - p), 1e-10);
      const r = y[i] - p;
      for (let a = 0; a < dim; a++) {
        grad[a] += r * xs[a];
        const row = Hm[a];
        for (let b = 0; b <= a; b++) row[b] += wgt * xs[a] * xs[b];
      }
    }
    for (let a = 0; a < dim; a++) for (let b = 0; b < a; b++) Hm[b][a] = Hm[a][b];
    for (let j = 1; j < dim; j++) {
      Hm[j][j] += lambda;
      grad[j] -= lambda * beta[j];
    }
    const delta = solveRidge(Hm, grad, 0);
    // Damped Newton: halve the step until the penalized log-likelihood improves.
    let step = 1;
    let next = null;
    let value = -Infinity;
    for (let tries = 0; tries < 30; tries++) {
      next = beta.map((b, j) => b + step * delta[j]);
      value = objective(next);
      if (value >= current) break;
      step /= 2;
    }
    if (!(value >= current)) break;
    const improvement = value - current;
    beta = next;
    current = value;
    if (improvement < 1e-9 * Math.abs(current)) break;
  }
  return { beta, mu, sd };
}

export function predictLogistic({ beta, mu, sd }, x) {
  let eta = beta[0];
  for (let j = 0; j < x.length; j++) eta += beta[j + 1] * ((x[j] - mu[j]) / sd[j]);
  return sigmoid(eta);
}
