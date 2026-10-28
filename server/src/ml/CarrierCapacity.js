// How many orders each carrier can take in a day.
// Limit = the lower of (busiest day seen x (1 + headroom)) and (maxShare x that day's order volume),
// so no single carrier can absorb most of a day's volume, and none is asked for far more than it has ever handled.

export const DEFAULT_HEADROOM = 0.25;
export const DEFAULT_MAX_SHARE = 0.4;

export class CarrierCapacity {
  constructor(peakLimit, { maxShare = DEFAULT_MAX_SHARE, headroom = DEFAULT_HEADROOM } = {}) {
    this.peakLimit = peakLimit;
    this.maxShare = maxShare;
    this.headroom = headroom;
  }

  /** @param rows [{ day, carrier_id }] one row per historical shipment */
  static fromHistory(rows, opts = {}) {
    const headroom = opts.headroom ?? DEFAULT_HEADROOM;
    const perDay = new Map();
    for (const { day, carrier_id } of rows) {
      const key = `${day}|${carrier_id}`;
      perDay.set(key, (perDay.get(key) || 0) + 1);
    }
    const peak = {};
    for (const [key, n] of perDay) {
      const carrier = key.split('|')[1];
      peak[carrier] = Math.max(peak[carrier] || 0, n);
    }
    const peakLimit = Object.fromEntries(Object.entries(peak).map(([c, n]) => [c, Math.floor(n * (1 + headroom))]));
    return new CarrierCapacity(peakLimit, { ...opts, headroom });
  }

  limitFor(carrierId, dayVolume) {
    return Math.min(this.peakLimit[carrierId] ?? 0, Math.max(1, Math.floor(this.maxShare * dayVolume)));
  }

  /** Mutable ledger for one day's orders. */
  forDay(dayVolume, used = {}) {
    const limits = Object.fromEntries(Object.keys(this.peakLimit).map((c) => [c, this.limitFor(c, dayVolume)]));
    const usage = Object.fromEntries(Object.keys(limits).map((c) => [c, used[c] || 0]));
    return {
      dayVolume,
      limits,
      usage,
      hasRoom: (c) => (usage[c] ?? 0) < (limits[c] ?? 0),
      remaining: (c) => Math.max(0, (limits[c] ?? 0) - (usage[c] ?? 0)),
      reserve: (c) => { usage[c] = (usage[c] || 0) + 1; },
    };
  }

  toJSON() { return { peakLimit: this.peakLimit, maxShare: this.maxShare, headroom: this.headroom }; }
}
