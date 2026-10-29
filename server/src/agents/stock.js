// Stock agent: learns each client's stock misses by destination region from the days it has seen,
// and each night moves stock to the nearest warehouse for the pairs that keep missing.
// It never looks ahead: planTransfers() uses only what observe() has been given.

const MIN_ORDERS = 10;

export class StockAgent {
  constructor(settings) {
    this.settings = settings;
    this.seen = new Map(); // 'client|region' -> { n, miss }
  }

  observe(dayOrders) {
    for (const o of dayOrders) {
      const k = `${o.client_id}|${o.destination_region}`;
      const s = this.seen.get(k) || { n: 0, miss: 0 };
      s.n++; s.miss += o.stock_miss ? 1 : 0;
      this.seen.set(k, s);
    }
  }

  /** @returns {{ pairs: Set<string>, decisions: { agent:'stock', pair:string, missRate:number, needsApproval:boolean, rule:string }[] }} */
  planTransfers() {
    const { stockMissThreshold, transferLimitPerNight } = this.settings;
    const qualifying = [...this.seen]
      .filter(([, s]) => s.n >= MIN_ORDERS && s.miss / s.n >= stockMissThreshold)
      .map(([pair, s]) => ({ pair, missRate: s.miss / s.n }))
      .sort((a, b) => b.missRate - a.missRate);
    const decisions = qualifying.map(({ pair, missRate }, i) => ({
      agent: 'stock',
      pair,
      missRate,
      needsApproval: i >= transferLimitPerNight,
      rule: `${Math.round(missRate * 100)}% of this client's orders to this region missed stock at the nearest warehouse`
        + (i >= transferLimitPerNight ? `; over tonight's limit of ${transferLimitPerNight} transfers` : ''),
    }));
    return { pairs: new Set(decisions.filter((d) => !d.needsApproval).map((d) => d.pair)), decisions };
  }
}
