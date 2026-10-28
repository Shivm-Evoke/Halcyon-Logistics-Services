// Learns each client's normal ordering pattern and flags incoming orders that break it.
// A rule fires only when the client has enough history for "unusual" to mean something.

const MIN_HISTORY = 30;
const RARE_SHARE = 0.02;

const share = (counts, key, n) => (counts[key] || 0) / n;

export class ClientProfiler {
  constructor() { this.profiles = new Map(); }

  fit(rows) {
    this.profiles.clear();
    for (const r of rows) {
      let p = this.profiles.get(r.client_id);
      if (!p) this.profiles.set(r.client_id, p = { n: 0, channel: {}, region: {}, commitment: {}, hour: {} });
      p.n++;
      p.channel[r.order_channel] = (p.channel[r.order_channel] || 0) + 1;
      p.region[r.destination_region] = (p.region[r.destination_region] || 0) + 1;
      p.commitment[r.commitment_type] = (p.commitment[r.commitment_type] || 0) + 1;
      p.hour[r.received_hour] = (p.hour[r.received_hour] || 0) + 1;
    }
    return this;
  }

  profile(clientId) { return this.profiles.get(clientId) || null; }

  /**
   * @param order    { client_id, order_id, order_channel, destination_region, commitment_type, received_hour, address_incomplete? }
   * @param context  { otherClientOrderIds?: Set, addressIssues?: string[] }
   * @returns {{ code, severity: 'high'|'medium'|'low', message }[]}
   */
  inspect(order, { otherClientOrderIds, addressIssues = [] } = {}) {
    const out = [];
    const add = (code, severity, message) => out.push({ code, severity, message });
    const p = this.profiles.get(order.client_id);

    if (!p) add('unknown_client', 'high', `Client ${order.client_id || '(blank)'} has no order history`);
    if (otherClientOrderIds?.has(order.order_id)) add('duplicate_order_id', 'high', `Order ID ${order.order_id} is already used by another client`);
    if (addressIssues.length) add('address_invalid', 'high', `Address failed validation: ${addressIssues.join('; ')}`);
    else if (order.address_incomplete) add('address_incomplete', 'high', 'Delivery address was ingested incomplete');
    if (order.commitment_type === 'same_day' && order.received_hour >= 8) {
      add('impossible_promise', 'medium', `Same-day requested at ${order.received_hour}:00, after the 08:00 pick-list cutoff`);
    }

    if (p && p.n >= MIN_HISTORY) {
      const r = share(p.region, order.destination_region, p.n);
      if (r < RARE_SHARE) add('unusual_destination', 'medium', `${order.destination_region} is ${(r * 100).toFixed(1)}% of this client's orders`);
      const c = share(p.channel, order.order_channel, p.n);
      if (c < RARE_SHARE) add('unusual_channel', 'low', `${order.order_channel} is ${(c * 100).toFixed(1)}% of this client's orders`);
      const k = share(p.commitment, order.commitment_type, p.n);
      if (k < RARE_SHARE) add('unusual_service', 'low', `${order.commitment_type} is ${(k * 100).toFixed(1)}% of this client's orders`);
      const h = share(p.hour, order.received_hour, p.n);
      if (h < RARE_SHARE / 2) add('unusual_time', 'low', `Orders at ${order.received_hour}:00 are rare for this client`);
    }
    return out;
  }
}
