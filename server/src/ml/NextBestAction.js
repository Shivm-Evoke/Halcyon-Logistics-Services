// Prescriptive layer: for one order, score every carrier x promise option with the risk model
// and pick the lowest expected cost = carrier rate + P(late) x cost of a late delivery + service cost.
import { PENALTY_USD, REDELIVERY_USD } from '../rules.js';

// Offering next-day instead of an unachievable same-day is not free: count it as a service cost.
export const DOWNGRADE_USD = 10;

export class NextBestAction {
  /** @param {{ risk(order): number }} scorer  @param {{ carriers: {carrier_id, avg_rate}[] }} market */
  constructor(scorer, { carriers }) {
    this.scorer = scorer;
    this.carriers = carriers;
  }

  options(order) {
    const promises = [order.commitment_type];
    if (order.commitment_type === 'same_day') promises.push('next_day');
    return this.carriers.flatMap((c) => promises.map((commitment_type) => ({
      carrier_id: c.carrier_id,
      commitment_type,
      rate: Number(c.avg_rate),
      downgraded: commitment_type !== order.commitment_type,
    })));
  }

  // Every option, cheapest expected cost first.
  score(order) {
    const lateCost = REDELIVERY_USD + (order.sla ? PENALTY_USD : 0);
    const options = this.options(order).map((o) => {
      const risk = this.scorer.risk({
        ...order,
        carrier_id: o.carrier_id,
        commitment_type: o.commitment_type,
        cutoff_breach: o.commitment_type === 'same_day' ? order.cutoff_breach : 0,
      });
      return { ...o, risk, expected_cost: o.rate + risk * lateCost + (o.downgraded ? DOWNGRADE_USD : 0) };
    }).sort((a, b) => a.expected_cost - b.expected_cost);
    return { options, lateCost };
  }

  /** One order. With a day ledger (`capacity`), carriers already at their limit are skipped. */
  decide(order, { capacity } = {}) {
    const { options, lateCost } = this.score(order);
    const marked = capacity ? options.map((o) => ({ ...o, full: !capacity.hasRoom(o.carrier_id) })) : options;
    const best = marked.find((o) => !o.full) || { ...marked[0], over_capacity: true };
    const current = marked.find((o) => o.carrier_id === order.carrier_id && !o.downgraded) || null;
    return { best, current, options: marked, late_cost: lateCost };
  }

  /**
   * A batch of orders sharing one day's capacity. Regret heuristic: orders that lose the most by not getting
   * their first-choice carrier are placed first, so scarce capacity goes where it is worth most.
   * If every carrier is full, the order takes its best option and is marked over_capacity.
   */
  allocate(orders, capacity) {
    const ranked = orders.map((order) => {
      const { options } = this.score(order);
      const alt = options.find((o) => o.carrier_id !== options[0].carrier_id);
      return { order, options, regret: alt ? alt.expected_cost - options[0].expected_cost : 0 };
    }).sort((a, b) => b.regret - a.regret);
    const assignments = ranked.map(({ order, options }) => {
      const pick = options.find((o) => capacity.hasRoom(o.carrier_id));
      const choice = pick || { ...options[0], over_capacity: true };
      capacity.reserve(choice.carrier_id);
      return { order, choice, first_choice: options[0] };
    });
    return { assignments, usage: capacity.usage, limits: capacity.limits };
  }
}
