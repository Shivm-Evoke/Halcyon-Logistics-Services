// Owns the live risk model: trains it, evaluates it out-of-time, persists it and serves it.
// Two models are kept: `evaluation` (trained before the test month, used for honest metrics and
// for scoring the September control-tower snapshot) and `production` (trained on everything).
import { RiskModel } from './RiskModel.js';
import { evaluate, roc } from './metrics.js';
import { RISK_FEATURES, makePrepare } from './features.js';
import { backtest } from './backtest.js';
import { CarrierCapacity } from './CarrierCapacity.js';

export const TEST_FROM = '2026-09-01';
export const RISK_THRESHOLD = 0.4;
const KIND = 'late_risk';

export class ModelRegistry {
  /** @param repo  { loadDeliveries, loadDistances, saveModel, loadLatestModel }
   *  @param carriers  [{ carrier_id, has_api, avg_rate }] */
  constructor(repo, { carriers, l2 = 1 }) {
    this.repo = repo;
    this.l2 = l2;
    this.carriers = carriers;
    this.prepare = makePrepare(new Set(carriers.filter((c) => c.has_api === 'N').map((c) => c.carrier_id)));
    this.models = null;
    this.meta = null;
  }

  async init() {
    const saved = await this.repo.loadLatestModel(KIND);
    if (saved) {
      this.models = { production: RiskModel.fromJSON(saved.params.production), evaluation: RiskModel.fromJSON(saved.params.evaluation) };
      if (!saved.params.capacity) return this.train();       // saved before capacity existed
      const { peakLimit, ...opts } = saved.params.capacity;
      this.capacity = new CarrierCapacity(peakLimit, opts);
      this.meta = { id: saved.id, version: saved.version, trained_at: saved.trained_at, ...saved.metrics };
      return this;
    }
    return this.train();
  }

  async train() {
    const started = performance.now();
    const rows = (await this.repo.loadDeliveries()).map(this.prepare);
    const train = rows.filter((r) => r.order_received_ts < TEST_FROM);
    const test = rows.filter((r) => r.order_received_ts >= TEST_FROM);

    const evaluation = new RiskModel(RISK_FEATURES, { l2: this.l2 }).fit(train);
    const p = test.map((r) => evaluation.risk(r));
    const y = test.map((r) => r.late);
    const production = new RiskModel(RISK_FEATURES, { l2: this.l2 }).fit(rows);
    // Carrier capacity is learned from the training period only, like the model.
    const dayOf = (r) => String(r.order_received_ts).slice(0, 10);
    this.capacity = CarrierCapacity.fromHistory(train.map((r) => ({ day: dayOf(r), carrier_id: r.carrier_id })));
    const trainMs = performance.now() - started;

    this.models = { production, evaluation };
    const metrics = {
      algorithm: 'L2 logistic regression (Newton/IRLS)',
      features: RISK_FEATURES.length,
      columns: production.encoder.width,
      train_rows: train.length,
      test_rows: test.length,
      all_rows: rows.length,
      split: `train < ${TEST_FROM} ≤ test`,
      iterations: production.lr.iterations,
      train_ms: Math.round(trainMs),
      threshold: RISK_THRESHOLD,
      test: { ...evaluate(p, y, RISK_THRESHOLD), roc: roc(p, y) },
      backtest: backtest(test, (r) => evaluation.risk(this.prepare(r)), {
        carriers: this.carriers, distances: await this.repo.loadDistances(), capacity: this.capacity,
      }),
    };
    const version = `lr-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    const saved = await this.repo.saveModel({
      kind: KIND, version, metrics, params: { production: production.toJSON(), evaluation: evaluation.toJSON(), capacity: this.capacity.toJSON() },
    });
    this.meta = { id: saved.id, version, trained_at: saved.trained_at, ...metrics };
    return this;
  }

  // Scorer interface used by every consumer: { risk(order), score(order) }.
  scorer(which = 'production') {
    const model = this.models[which];
    return {
      risk: (order) => model.risk(this.prepare(order)),
      score: (order) => model.score(this.prepare(order)),
    };
  }

  coefficients() { return this.models.production.coefficients(); }
}
