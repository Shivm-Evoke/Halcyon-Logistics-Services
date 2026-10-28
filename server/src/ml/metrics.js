// Evaluation metrics for a binary classifier. p = predicted probabilities, y = 0/1 labels.

// Area under the ROC curve via the rank-sum (Mann–Whitney) formula, with ties averaged.
export function auc(p, y) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  const ranks = new Float64Array(p.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j++;
    for (let k = i; k <= j; k++) ranks[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let pos = 0; let rankSum = 0;
  y.forEach((v, i) => { if (v) { pos++; rankSum += ranks[i]; } });
  const neg = y.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

export function classification(p, y, threshold) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  p.forEach((v, i) => {
    const hit = v >= threshold;
    if (hit && y[i]) tp++; else if (hit) fp++; else if (y[i]) fn++; else tn++;
  });
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    threshold, tp, fp, fn, tn, precision, recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    accuracy: (tp + tn) / p.length,
  };
}

export const logLoss = (p, y) => -p.reduce((s, v, i) => {
  const q = Math.min(Math.max(v, 1e-12), 1 - 1e-12);
  return s + (y[i] ? Math.log(q) : Math.log(1 - q));
}, 0) / p.length;

export const brier = (p, y) => p.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / p.length;

// Predicted vs actual late rate in equal-width probability bins (empty bins dropped).
export function calibration(p, y, bins = 10) {
  const acc = Array.from({ length: bins }, (_, b) => ({ lo: b / bins, hi: (b + 1) / bins, n: 0, sumP: 0, sumY: 0 }));
  p.forEach((v, i) => {
    const b = acc[Math.min(bins - 1, Math.floor(v * bins))];
    b.n++; b.sumP += v; b.sumY += y[i];
  });
  return acc.filter((b) => b.n).map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, predicted: b.sumP / b.n, actual: b.sumY / b.n }));
}

// ROC curve sampled at up to `points` thresholds: [{ threshold, fpr, tpr }].
export function roc(p, y, points = 40) {
  const pos = y.reduce((s, v) => s + v, 0);
  const neg = y.length - pos;
  const order = p.map((v, i) => i).sort((a, b) => p[b] - p[a]);
  const out = [{ threshold: 1, fpr: 0, tpr: 0 }];
  const every = Math.max(1, Math.floor(order.length / points));
  let tp = 0; let fp = 0;
  order.forEach((i, k) => {
    if (y[i]) tp++; else fp++;
    if ((k + 1) % every === 0 || k === order.length - 1) out.push({ threshold: p[i], fpr: fp / neg, tpr: tp / pos });
  });
  return out;
}

export function evaluate(p, y, threshold = 0.4) {
  return {
    n: p.length,
    base_rate: y.reduce((s, v) => s + v, 0) / y.length,
    auc: auc(p, y),
    log_loss: logLoss(p, y),
    brier: brier(p, y),
    at_threshold: classification(p, y, threshold),
    calibration: calibration(p, y),
  };
}
