// Data access for the agents: every delivery with the fields the ML layer uses, plus what the agents also need.
import { q } from '../db.js';
import { mlRepository } from '../ml/repository.js';

export const agentsRepository = {
  async loadOrders() {
    const [rows, extra] = await Promise.all([
      mlRepository.loadDeliveries(),
      q(`SELECT d.delivery_id, d.carrier_rate_usd, c.account_status
         FROM deliveries d JOIN clients c USING (client_id)`),
    ]);
    const byId = new Map(extra.map((e) => [e.delivery_id, e]));
    return rows.map((r) => ({ ...r, ...byId.get(r.delivery_id), received_ts: r.order_received_ts }));
  },
};
