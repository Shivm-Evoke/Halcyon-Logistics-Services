// Data access for the ML layer. The registry and services depend on this shape, not on SQL.
import { q, one } from '../db.js';

export const mlRepository = {
  // One row per delivery with model features, the label and a few ids for reporting.
  loadDeliveries: () => q(`
    SELECT v.delivery_id, v.order_id, v.client_id, c.client_name, v.order_channel, v.commitment_type,
           v.received_hour, extract(dow FROM v.order_received_ts)::int AS received_dow,
           v.f_cutoff::int AS cutoff_breach, (v.received_hour >= 8)::int AS after_cutoff,
           v.f_address::int AS address_incomplete, v.f_stock::int AS stock_miss,
           v.carrier_id, v.distance_miles, v.destination_region, v.fulfilment_warehouse_id, v.nearest_warehouse_id,
           c.account_tier, (c.sla_penalty_clause = 'Y')::int AS sla, v.stops_on_route,
           v.is_late::int AS late, v.days_late, v.order_received_ts, v.promised_date, v.delivered_date
    FROM v_deliveries v JOIN clients c USING (client_id)
    ORDER BY v.order_received_ts`),

  // Miles from each warehouse to each region, as { W1: { Midwest: 150, ... }, ... }.
  async loadDistances() {
    const rows = await q('SELECT * FROM warehouse_region_distance');
    return Object.fromEntries(rows.map((r) => [r.warehouse_id, {
      Midwest: r.midwest, Southeast: r.southeast, Northeast: r.northeast, West: r.west,
    }]));
  },

  saveModel: ({ kind, version, metrics, params }) => one(
    'INSERT INTO ml_models (kind, version, metrics, params) VALUES ($1, $2, $3, $4) RETURNING id, trained_at',
    [kind, version, metrics, params]),

  loadLatestModel: (kind) => one('SELECT * FROM ml_models WHERE kind = $1 ORDER BY id DESC LIMIT 1', [kind]),
};
