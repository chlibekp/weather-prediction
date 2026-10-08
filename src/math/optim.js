// Derivative-free minimization (Nelder–Mead simplex).
export function nelderMead(f, x0, { step = 0.05, maxIter = 1000, tol = 1e-10 } = {}) {
  const n = x0.length;
  if (n === 0) return { x: [], fx: f([]), iterations: 0 };

  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += step;
    simplex.push(v);
  }
  let values = simplex.map(f);

  const combine = (a, b, t) => a.map((ai, i) => ai + t * (b[i] - ai));
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);

    const best = values[0];
    const worst = values[n];
    if (Math.abs(worst - best) <= tol * (Math.abs(best) + 1e-12)) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    }

    const reflected = combine(centroid, simplex[n], -1);
    const fr = f(reflected);
    if (fr < best) {
      const expanded = combine(centroid, simplex[n], -2);
      const fe = f(expanded);
      if (fe < fr) {
        simplex[n] = expanded;
        values[n] = fe;
      } else {
        simplex[n] = reflected;
        values[n] = fr;
      }
      continue;
    }
    if (fr < values[n - 1]) {
      simplex[n] = reflected;
      values[n] = fr;
      continue;
    }
    const outside = fr < worst;
    const contracted = combine(centroid, outside ? reflected : simplex[n], 0.5);
    const fc = f(contracted);
    if (fc < (outside ? fr : worst)) {
      simplex[n] = contracted;
      values[n] = fc;
      continue;
    }
    for (let i = 1; i <= n; i++) {
      simplex[i] = combine(simplex[0], simplex[i], 0.5);
      values[i] = f(simplex[i]);
    }
  }
  return { x: simplex[0], fx: values[0], iterations: iter };
}
