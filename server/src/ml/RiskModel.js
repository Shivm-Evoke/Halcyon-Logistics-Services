// Late-delivery risk model: feature encoding + logistic regression + per-order explanations.
import { FeatureEncoder } from './FeatureEncoder.js';
import { LogisticRegression, sigmoid } from './LogisticRegression.js';

export class RiskModel {
  constructor(spec, { l2 = 1 } = {}, parts = {}) {
    this.encoder = parts.encoder || new FeatureEncoder(spec);
    this.lr = parts.lr || new LogisticRegression({ l2 });
  }

  fit(rows, label = 'late') {
    this.encoder.fit(rows);
    this.lr.fit(rows.map((r) => this.encoder.encode(r)), rows.map((r) => (r[label] ? 1 : 0)));
    return this;
  }

  // Hot path: no allocation, a few dozen multiply-adds.
  logit(row) {
    const w = this.lr.weights;
    let z = this.lr.bias;
    this.encoder.each(row, (i, v) => { z += w[i] * v; });
    return z;
  }

  risk(row) { return sigmoid(this.logit(row)); }

  // Risk plus the features that pushed it up or down, relative to an average order.
  // impact = how much the probability would fall if this feature were at its average value.
  score(row) {
    const x = this.encoder.encode(row);
    const w = this.lr.weights;
    const z = this.logit(row);
    const risk = sigmoid(z);
    const byGroup = {};
    for (let i = 0; i < x.length; i++) {
      const g = this.encoder.groupOf[i];
      byGroup[g] = (byGroup[g] || 0) + w[i] * (x[i] - this.encoder.means[i]);
    }
    const drivers = Object.entries(byGroup)
      .map(([feature, c]) => ({ feature, value: row[feature] ?? null, logit: c, impact: risk - sigmoid(z - c) }))
      .filter((d) => Math.abs(d.impact) >= 0.005)
      .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    return { risk, drivers };
  }

  // Global importance per feature: the spread (std. dev.) of its contribution to the log-odds
  // across the training data, so binary, categorical and numeric features compare fairly.
  importance() {
    const { columns, groupOf, means, spec } = this.encoder;
    const w = this.lr.weights;
    return spec.map((f) => {
      const idx = columns.map((_, i) => i).filter((i) => groupOf[i] === f.name);
      let spread;
      if (f.type === 'categorical') {
        const avg = idx.reduce((s, i) => s + means[i] * w[i], 0);
        spread = Math.sqrt(idx.reduce((s, i) => s + means[i] * (w[i] - avg) ** 2, 0));
      } else if (f.type === 'binary') {
        const m = Math.min(Math.max(means[idx[0]], 0), 1);
        spread = Math.abs(w[idx[0]]) * Math.sqrt(m * (1 - m));
      } else {
        spread = Math.abs(w[idx[0]]);   // numerics are standardised
      }
      return { feature: f.name, importance: spread };
    }).sort((a, b) => b.importance - a.importance);
  }

  // Weights per column, for the model screen.
  coefficients() {
    return this.encoder.columns.map((column, i) => ({ column, feature: this.encoder.groupOf[i], weight: this.lr.weights[i] }));
  }

  toJSON() { return { encoder: this.encoder.toJSON(), lr: this.lr.toJSON() }; }

  static fromJSON(j) {
    return new RiskModel(null, {}, { encoder: FeatureEncoder.fromJSON(j.encoder), lr: LogisticRegression.fromJSON(j.lr) });
  }
}
