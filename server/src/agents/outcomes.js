// How likely an order is to arrive on time, given the decisions taken about it.
// Every rate is measured on Halcyon's own history, so the agents' uplift traces back to recorded deliveries:
// a clean order on carrier B under 300 miles is as likely to be on time as such orders were.

export const distanceBand = (miles) => (miles < 300 ? '<300' : miles < 800 ? '300-800' : '800+');

const flags = (o) => `${o.cutoff_breach ? 1 : 0}${o.address_incomplete ? 1 : 0}${o.stock_miss ? 1 : 0}`;

// From most to least specific; a cell with too few deliveries hands over to the next one.
const LEVELS = [
  (o) => `${o.carrier_id}|${distanceBand(o.distance_miles)}|${o.commitment_type}|${flags(o)}`,
  (o) => `${o.carrier_id}|${distanceBand(o.distance_miles)}|*|${flags(o)}`,
  (o) => `*|${distanceBand(o.distance_miles)}|*|${flags(o)}`,
  (o) => `*|*|*|${flags(o)}`,
];

export class OutcomeModel {
  constructor(levels, overall, minCell) {
    this.levels = levels;
    this.overall = overall;
    this.minCell = minCell;
  }

  /** @param rows deliveries with carrier_id, distance_miles, commitment_type, the three flags and late (0/1) */
  static fromHistory(rows, { minCell = 30 } = {}) {
    const levels = LEVELS.map(() => new Map());
    let onTime = 0;
    for (const r of rows) {
      const ok = r.late ? 0 : 1;
      onTime += ok;
      LEVELS.forEach((key, i) => {
        const k = key(r);
        const c = levels[i].get(k) || { n: 0, ok: 0 };
        c.n++; c.ok += ok;
        levels[i].set(k, c);
      });
    }
    return new OutcomeModel(levels, rows.length ? onTime / rows.length : 0, minCell);
  }

  pOnTime(order) {
    for (let i = 0; i < LEVELS.length; i++) {
      const c = this.levels[i].get(LEVELS[i](order));
      if (c && (c.n >= this.minCell || i === LEVELS.length - 1)) return c.ok / c.n;
    }
    return this.overall;
  }
}
