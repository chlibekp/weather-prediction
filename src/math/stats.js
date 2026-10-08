export const Z80 = 1.2815515655446004;
export const Z95 = 1.959963984540054;

export function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : NaN;
}

export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const sorted = Float64Array.from(xs).sort();
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}
