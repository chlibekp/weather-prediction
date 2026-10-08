// Multiplicative seasonal ARIMA(p,d,q)(P,0,Q)_s on an anomaly series.
//
//   φ(B) Φ(B^s) (1-B)^d (z_t - μ) = θ(B) Θ(B^s) e_t
//
// Estimation: Hannan–Rissanen regressions screen a grid of orders by AIC, then the best
// candidates are refined by minimizing the conditional sum of squares (Nelder–Mead).
import { Gram } from '../math/linalg.js';
import { nelderMead } from '../math/optim.js';

export const SEASON = 24;
const LONG_AR = 48;
const ROOT_LIMIT = 0.99;

export function polyMul(a, b) {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

// Polynomial in B with coefficient sign `sign` on every lag term: 1 + sign*c1 B + sign*c2 B^2 ...
function lagPoly(coefs, spacing, sign) {
  const p = new Float64Array(coefs.length * spacing + 1);
  p[0] = 1;
  coefs.forEach((c, i) => {
    p[(i + 1) * spacing] = sign * c;
  });
  return p;
}

export function arPolynomial({ phi, Phi }, s = SEASON) {
  return polyMul(lagPoly(phi, 1, -1), lagPoly(Phi, s, -1));
}

export function maPolynomial({ theta, Theta }, s = SEASON) {
  return polyMul(lagPoly(theta, 1, 1), lagPoly(Theta, s, 1));
}

function nonzeroLags(poly) {
  const lags = [];
  for (let k = 1; k < poly.length; k++) if (poly[k] !== 0) lags.push(k);
  return lags;
}

// Step-down (reverse Levinson) test: AR polynomial 1 - Σ φ_i B^i has all roots outside the unit circle.
export function isStationary(phi, limit = ROOT_LIMIT) {
  let a = phi.slice();
  for (let k = a.length; k >= 1; k--) {
    const kk = a[k - 1];
    if (!(Math.abs(kk) < limit)) return false;
    const next = [];
    for (let i = 0; i < k - 1; i++) next.push((a[i] + kk * a[k - 2 - i]) / (1 - kk * kk));
    a = next;
  }
  return true;
}

export function isValid({ phi, Phi, theta, Theta }) {
  return (
    isStationary(phi) &&
    isStationary(Phi) &&
    isStationary(theta.map((v) => -v)) &&
    isStationary(Theta.map((v) => -v))
  );
}

export function difference(z, mask, d) {
  const n = z.length;
  const w = new Float64Array(n);
  const wm = new Uint8Array(n);
  if (d === 0) {
    w.set(z);
    wm.set(mask);
    return { w, mask: wm };
  }
  for (let t = 1; t < n; t++) {
    w[t] = z[t] - z[t - 1];
    wm[t] = mask[t] && mask[t - 1] ? 1 : 0;
  }
  return { w, mask: wm };
}

// One-step-ahead residuals with pre-sample shocks set to zero. Interpolated points
// (mask = 0) get a zero shock and are excluded from the sum of squares.
export function residuals(w, mask, a, m, burnIn = 0) {
  const n = w.length;
  const e = new Float64Array(n);
  const aL = nonzeroLags(a);
  const mL = nonzeroLags(m);
  const start = a.length - 1;
  const burn = Math.max(start + m.length - 1, burnIn);
  let css = 0;
  let count = 0;
  for (let t = start; t < n; t++) {
    let pred = 0;
    for (const k of aL) pred -= a[k] * w[t - k];
    for (const k of mL) if (t - k >= 0) pred += m[k] * e[t - k];
    if (mask[t]) {
      const r = w[t] - pred;
      e[t] = r;
      if (t >= burn) {
        css += r * r;
        count++;
      }
    }
  }
  return { e, css, count };
}

function packParams(order, vec) {
  let i = 0;
  const take = (k) => vec.slice(i, (i += k));
  return {
    phi: take(order.p),
    Phi: take(order.P),
    theta: take(order.q),
    Theta: take(order.Q),
  };
}

function prepare(z, mask, d) {
  const { w, mask: wm } = difference(z, mask, d);
  let mu = 0;
  if (d === 0) {
    let s = 0;
    let c = 0;
    for (let t = 0; t < w.length; t++) {
      if (wm[t]) {
        s += w[t];
        c++;
      }
    }
    mu = c ? s / c : 0;
    for (let t = 0; t < w.length; t++) w[t] -= mu;
  }
  return { w, wm, mu };
}

// Hannan–Rissanen: long AR → residual proxies → OLS on lagged values and lagged residuals.
function hannanRissanen(w, wm, { maxP, maxQ, maxSP, maxSQ }) {
  const n = w.length;
  const longAr = new Gram(LONG_AR);
  const x = new Float64Array(LONG_AR);
  for (let t = LONG_AR; t < n; t++) {
    if (!wm[t]) continue;
    for (let k = 0; k < LONG_AR; k++) x[k] = w[t - k - 1];
    longAr.add(x, w[t]);
  }
  const beta = longAr.solve(1e-6);
  const ehat = new Float64Array(n);
  for (let t = LONG_AR; t < n; t++) {
    if (!wm[t]) continue;
    let pred = 0;
    for (let k = 0; k < LONG_AR; k++) pred += beta[k] * w[t - k - 1];
    ehat[t] = w[t] - pred;
  }

  // Candidate regressors: w lags 1..maxP, s, s+1..s+maxP and e lags 1..maxQ, s, s+1..s+maxQ.
  // The s+k lags are the cross terms of the multiplicative seasonal operator.
  const regs = [];
  const wLag = new Map();
  const eLag = new Map();
  const addReg = (src, map, lag) => {
    map.set(lag, regs.length);
    regs.push({ src, lag });
  };
  for (let k = 1; k <= maxP; k++) addReg(w, wLag, k);
  addReg(w, wLag, SEASON);
  for (let k = 1; k <= maxP; k++) addReg(w, wLag, SEASON + k);
  for (let k = 1; k <= maxQ; k++) addReg(ehat, eLag, k);
  addReg(ehat, eLag, SEASON);
  for (let k = 1; k <= maxQ; k++) addReg(ehat, eLag, SEASON + k);
  const g = new Gram(regs.length);
  const row = new Float64Array(regs.length);
  for (let t = LONG_AR + SEASON + Math.max(maxP, maxQ); t < n; t++) {
    if (!wm[t]) continue;
    regs.forEach((r, i) => {
      row[i] = r.src[t - r.lag];
    });
    g.add(row, w[t]);
  }

  const results = [];
  for (let p = 0; p <= maxP; p++) {
    for (let q = 0; q <= maxQ; q++) {
      for (let P = 0; P <= maxSP; P++) {
        for (let Q = 0; Q <= maxSQ; Q++) {
          const idx = [];
          for (let k = 1; k <= p; k++) idx.push(wLag.get(k));
          if (P) idx.push(wLag.get(SEASON));
          for (let k = 1; k <= q; k++) idx.push(eLag.get(k));
          if (Q) idx.push(eLag.get(SEASON));
          const cross = [];
          if (P) for (let k = 1; k <= p; k++) cross.push(wLag.get(SEASON + k));
          if (Q) for (let k = 1; k <= q; k++) cross.push(eLag.get(SEASON + k));
          let coef = [];
          let rss = g.yty;
          if (idx.length) {
            const sub = g.subset([...idx, ...cross]);
            coef = sub.solve(1e-9);
            rss = sub.rss(coef);
          }
          // Cross terms are implied by the multiplicative form, so they are not counted.
          const k = idx.length;
          const aic = g.n * Math.log(rss / g.n) + 2 * k;
          let i = 0;
          const init = {
            phi: coef.slice(i, (i += p)),
            Phi: coef.slice(i, (i += P)),
            theta: coef.slice(i, (i += q)),
            Theta: coef.slice(i, (i += Q)),
          };
          results.push({ order: { p, q, P, Q }, init, aic });
        }
      }
    }
  }
  return results.sort((a, b) => a.aic - b.aic);
}

function shrinkToValid(params) {
  let scale = 1;
  const scaled = () => {
    const out = {};
    for (const key of Object.keys(params)) out[key] = params[key].map((v) => v * scale);
    return out;
  };
  for (let i = 0; i < 40; i++) {
    const candidate = scaled();
    if (isValid(candidate)) return candidate;
    scale *= 0.8;
  }
  return scaled();
}

export function fitSarima(z, mask, d, opts = {}) {
  const grid = { maxP: 3, maxQ: 3, maxSP: 1, maxSQ: 1, ...opts };
  const candidates = opts.candidates ?? 4;
  // Same evaluation window for every candidate so their AICs are comparable.
  const burnIn = 2 * (SEASON * Math.max(grid.maxSP, grid.maxSQ) + Math.max(grid.maxP, grid.maxQ)) + 1;
  const { w, wm, mu } = prepare(z, mask, d);
  const screened = hannanRissanen(w, wm, grid).slice(0, candidates);

  let best = null;
  for (const { order, init } of screened) {
    const start = shrinkToValid(init);
    const vec0 = [...start.phi, ...start.Phi, ...start.theta, ...start.Theta];
    const objective = (vec) => {
      const params = packParams(order, vec);
      if (!isValid(params)) return 1e300;
      const { css, count } = residuals(w, wm, arPolynomial(params), maPolynomial(params), burnIn);
      return css / count;
    };
    const { x } = nelderMead(objective, vec0, {
      step: 0.05,
      maxIter: 150 * Math.max(vec0.length, 1),
      tol: 1e-9,
    });
    const params = packParams(order, x);
    const { css, count } = residuals(w, wm, arPolynomial(params), maPolynomial(params), burnIn);
    const sigma2 = css / count;
    const k = vec0.length;
    const aic = count * Math.log(sigma2) + 2 * (k + 1);
    if (!best || aic < best.aic) {
      best = { d, mu, ...order, ...params, sigma2, aic, n: count };
    }
  }
  return best;
}

export function describeOrder(m) {
  return `SARIMA(${m.p},${m.d},${m.q})(${m.P},0,${m.Q})${SEASON}`;
}

// ψ-weights of the full ARIMA operator, used for forecast error variance.
export function psiWeights(model, H) {
  let A = arPolynomial(model);
  for (let i = 0; i < model.d; i++) A = polyMul(A, [1, -1]);
  const M = maPolynomial(model);
  const psi = new Float64Array(H);
  psi[0] = 1;
  for (let j = 1; j < H; j++) {
    let s = j < M.length ? M[j] : 0;
    for (let k = 1; k <= Math.min(j, A.length - 1); k++) s -= A[k] * psi[j - k];
    psi[j] = s;
  }
  return psi;
}

export function forecastSd(model, H) {
  const psi = psiWeights(model, H);
  const sd = new Float64Array(H);
  let acc = 0;
  for (let h = 0; h < H; h++) {
    acc += psi[h] * psi[h];
    sd[h] = Math.sqrt(model.sigma2 * acc);
  }
  return sd;
}

// Run the filter over a series once; afterwards forecasts can start at any origin cheaply.
export function sarimaState(model, z, mask) {
  const { w, mask: wm } = difference(z, mask, model.d);
  if (model.d === 0) for (let t = 0; t < w.length; t++) w[t] -= model.mu;
  const a = arPolynomial(model);
  const m = maPolynomial(model);
  const { e } = residuals(w, wm, a, m);
  return { z, w, e, a, m, aL: nonzeroLags(a), mL: nonzeroLags(m) };
}

// Point forecasts z_{o+1..o+H} using only information up to index o.
export function forecastFrom(model, state, o, H) {
  const { z, w, e, a, m, aL, mL } = state;
  const wf = new Float64Array(H);
  const getW = (t) => (t <= o ? (t >= 0 ? w[t] : 0) : wf[t - o - 1]);
  const getE = (t) => (t <= o && t >= 0 ? e[t] : 0);
  for (let h = 1; h <= H; h++) {
    const t = o + h;
    let pred = 0;
    for (const k of aL) pred -= a[k] * getW(t - k);
    for (const k of mL) pred += m[k] * getE(t - k);
    wf[h - 1] = pred;
  }
  const out = new Float64Array(H);
  if (model.d === 0) {
    for (let h = 0; h < H; h++) out[h] = wf[h] + model.mu;
  } else {
    let level = z[o];
    for (let h = 0; h < H; h++) out[h] = level += wf[h];
  }
  return out;
}
