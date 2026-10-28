// Turns a plain order/delivery object into a numeric feature vector.
// Spec entries: { name, type: 'categorical' | 'binary' | 'numeric', values?, transform? }.
// Binary features accept fractions (e.g. a probability) so uncertain inputs can still be scored.

const TRANSFORMS = { log1p: Math.log1p, none: (v) => v };

export class FeatureEncoder {
  constructor(spec) {
    this.spec = spec;
    this.columns = [];
    this.groupOf = [];          // column index -> feature name, used to group explanations
    this.offset = {};           // feature name -> first column index
    for (const f of spec) {
      this.offset[f.name] = this.columns.length;
      const cols = f.type === 'categorical' ? f.values.map((v) => `${f.name}=${v}`) : [f.name];
      for (const c of cols) { this.columns.push(c); this.groupOf.push(f.name); }
    }
    this.width = this.columns.length;
    this.stats = {};            // numeric/binary feature -> { mean, std }
    this.means = new Float64Array(this.width);
  }

  fit(rows) {
    for (const f of this.spec) {
      if (f.type === 'categorical') continue;
      const t = TRANSFORMS[f.transform || 'none'];
      const vals = rows.map((r) => r[f.name]).filter((v) => v != null).map((v) => t(Number(v)));
      const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length || 1)) || 1;
      this.stats[f.name] = { mean, std };
    }
    // Column means of the encoded training data: the "average order" explanations are measured against.
    this.means.fill(0);
    for (const r of rows) this.encode(r).forEach((v, i) => { this.means[i] += v; });
    for (let i = 0; i < this.width; i++) this.means[i] /= rows.length || 1;
    return this;
  }

  // Calls visit(columnIndex, value) for each non-zero column, without allocating.
  each(row, visit) {
    for (const f of this.spec) {
      const at = this.offset[f.name];
      const v = row[f.name];
      if (f.type === 'categorical') {
        const k = f.values.indexOf(v);
        if (k >= 0) visit(at + k, 1);
      } else if (f.type === 'binary') {
        const x = v == null ? this.stats[f.name]?.mean ?? 0 : Number(v);
        if (x) visit(at, x);
      } else {
        const s = this.stats[f.name] || { mean: 0, std: 1 };
        if (v != null) visit(at, (TRANSFORMS[f.transform || 'none'](Number(v)) - s.mean) / s.std);
      }
    }
  }

  encode(row) {
    const x = new Float64Array(this.width);
    this.each(row, (i, v) => { x[i] = v; });
    return x;
  }

  toJSON() { return { spec: this.spec, stats: this.stats, means: Array.from(this.means) }; }

  static fromJSON(j) {
    const e = new FeatureEncoder(j.spec);
    e.stats = j.stats;
    e.means = Float64Array.from(j.means);
    return e;
  }
}
