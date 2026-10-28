// What-if for carrier capacity: re-runs the September backtest with a different max share per carrier
// and extra capacity (headroom), so leadership can see how much capacity the AI plan needs.
import { CarrierCapacity } from './CarrierCapacity.js';
import { backtest } from './backtest.js';

const dayOf = (r) => String(r.order_received_ts).slice(0, 10);

export class CapacitySimulator {
  /** @param rows all delivery rows   @param riskFn evaluation-model scorer   @param splitAt first test-period timestamp */
  constructor({ rows, riskFn, carriers, distances, splitAt }) {
    this.history = rows.filter((r) => r.order_received_ts < splitAt).map((r) => ({ day: dayOf(r), carrier_id: r.carrier_id }));
    this.test = rows.filter((r) => r.order_received_ts >= splitAt);
    Object.assign(this, { riskFn, carriers, distances });
    this.cache = new Map();
  }

  run({ maxShare, headroom }) {
    const key = `${maxShare}|${headroom}`;
    if (!this.cache.has(key)) {
      const capacity = CarrierCapacity.fromHistory(this.history, { maxShare, headroom });
      const b = backtest(this.test, this.riskFn, { carriers: this.carriers, distances: this.distances, capacity });
      this.cache.set(key, {
        max_share: maxShare,
        headroom,
        peak_limits: capacity.peakLimit,
        on_time: b.scenarios.at(-1).on_time,
        unconstrained_on_time: b.unconstrained_on_time,
        carrier_mix: b.carrier_mix,
        peak_daily_share: b.peak_daily_share,
        over_capacity_orders: b.over_capacity_orders,
        expected_cost_per_order: b.expected_cost_per_order.next_best_action,
      });
    }
    return this.cache.get(key);
  }
}
