// L2-regularised logistic regression trained with Newton's method (IRLS).
// Newton converges in a handful of passes, so training on ~50K rows takes well under a second.

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export class LogisticRegression {
  constructor({ l2 = 1, maxIter = 30, tol = 1e-6 } = {}) {
    Object.assign(this, { l2, maxIter, tol });
    this.weights = [];
    this.bias = 0;
    this.iterations = 0;
  }

  logit(x) {
    let z = this.bias;
    for (let i = 0; i < x.length; i++) z += this.weights[i] * x[i];
    return z;
  }

  predict(x) { return sigmoid(this.logit(x)); }

  fit(X, y) {
    const d = X[0].length + 1;                 // last slot is the intercept
    const w = new Float64Array(d);
    const H = new Float64Array(d * d);
    const g = new Float64Array(d);
    for (this.iterations = 1; this.iterations <= this.maxIter; this.iterations++) {
      H.fill(0); g.fill(0);
      for (let n = 0; n < X.length; n++) {
        const x = X[n];
        let z = w[d - 1];
        for (let i = 0; i < d - 1; i++) z += w[i] * x[i];
        const p = sigmoid(z);
        const r = y[n] - p;
        const s = p * (1 - p);
        for (let a = 0; a < d; a++) {
          const xa = a === d - 1 ? 1 : x[a];
          if (xa === 0) continue;
          g[a] += r * xa;
          const row = a * d;
          for (let b = a; b < d; b++) {
            const xb = b === d - 1 ? 1 : x[b];
            if (xb !== 0) H[row + b] += s * xa * xb;
          }
        }
      }
      for (let a = 0; a < d; a++) {
        for (let b = 0; b < a; b++) H[a * d + b] = H[b * d + a];
        if (a < d - 1) { H[a * d + a] += this.l2; g[a] -= this.l2 * w[a]; }
      }
      const step = choleskySolve(H, g, d);
      let max = 0;
      for (let i = 0; i < d; i++) { w[i] += step[i]; max = Math.max(max, Math.abs(step[i])); }
      if (max < this.tol) break;
    }
    this.weights = Array.from(w.subarray(0, d - 1));
    this.bias = w[d - 1];
    return this;
  }

  toJSON() { return { l2: this.l2, weights: this.weights, bias: this.bias, iterations: this.iterations }; }

  static fromJSON(j) { return Object.assign(new LogisticRegression({ l2: j.l2 }), j); }
}

// Solves A x = b for a symmetric positive-definite A (row-major, n x n).
function choleskySolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}
