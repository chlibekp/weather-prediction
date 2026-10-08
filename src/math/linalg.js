// Small dense linear algebra helpers: Cholesky solves and streaming normal equations.

export function choleskySolve(A, b) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

// Solve (A + ridge * I) x = b. `ridge` is relative to the mean diagonal so it is scale-free.
// Indices in `unpenalized` (e.g. an intercept) get no ridge. Retries with more ridge if A is singular.
export function solveRidge(A, b, ridge = 1e-9, unpenalized = []) {
  const n = b.length;
  let trace = 0;
  for (let i = 0; i < n; i++) trace += A[i][i];
  const scale = Math.max(trace / Math.max(n, 1), 1e-12);
  const skip = new Set(unpenalized);
  let lambda = ridge;
  for (let attempt = 0; attempt < 12; attempt++) {
    const M = A.map((row, i) => {
      const r = Float64Array.from(row);
      r[i] += skip.has(i) ? lambda * scale * 1e-6 : lambda * scale;
      return r;
    });
    const x = choleskySolve(M, b);
    if (x) return x;
    lambda = Math.max(lambda * 100, 1e-10);
  }
  throw new Error('Linear system is singular');
}

// Accumulates X'X, X'y and y'y row by row so large regressions never hold X in memory.
export class Gram {
  constructor(k) {
    this.k = k;
    this.xtx = Array.from({ length: k }, () => new Float64Array(k));
    this.xty = new Float64Array(k);
    this.yty = 0;
    this.n = 0;
    this.symmetric = true;
  }

  add(x, y) {
    const k = this.k;
    for (let i = 0; i < k; i++) {
      const xi = x[i];
      if (xi === 0) continue;
      const row = this.xtx[i];
      for (let j = 0; j <= i; j++) row[j] += xi * x[j];
      this.xty[i] += xi * y;
    }
    this.yty += y * y;
    this.n++;
    this.symmetric = false;
  }

  #symmetrize() {
    if (this.symmetric) return;
    for (let i = 0; i < this.k; i++) {
      for (let j = 0; j < i; j++) this.xtx[j][i] = this.xtx[i][j];
    }
    this.symmetric = true;
  }

  subset(indices) {
    this.#symmetrize();
    const g = new Gram(indices.length);
    indices.forEach((ii, a) => {
      indices.forEach((jj, b) => {
        g.xtx[a][b] = this.xtx[ii][jj];
      });
      g.xty[a] = this.xty[ii];
    });
    g.yty = this.yty;
    g.n = this.n;
    return g;
  }

  solve(ridge = 1e-9, unpenalized = []) {
    this.#symmetrize();
    return solveRidge(this.xtx, this.xty, ridge, unpenalized);
  }

  rss(beta) {
    this.#symmetrize();
    let r = this.yty;
    for (let i = 0; i < this.k; i++) {
      r -= 2 * beta[i] * this.xty[i];
      for (let j = 0; j < this.k; j++) r += beta[i] * this.xtx[i][j] * beta[j];
    }
    return Math.max(r, 0);
  }
}
