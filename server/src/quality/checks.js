// Data-quality rules over the ingested records. Each check is a query returning the offending rows
// (with a `ref` id and a `detail`), so adding a rule means adding one entry here and nothing else.

export const CHECKS = [
  {
    id: 'duplicate_order_id', severity: 'high', source: 'Client order feeds',
    title: 'Order ID reused by different clients',
    why: 'Two clients sending the same order reference breaks matching of confirmations, complaints and invoices.',
    sql: `SELECT d.delivery_id AS ref, d.client_id, 'Order ' || d.order_id || ' also used by ' ||
                 string_agg(o.client_id, ', ') AS detail
          FROM deliveries d JOIN deliveries o ON o.order_id = d.order_id AND o.client_id <> d.client_id
          GROUP BY d.delivery_id, d.client_id, d.order_id`,
  },
  {
    id: 'address_incomplete', severity: 'high', source: 'Client order feeds',
    title: 'Delivery address incomplete at intake',
    why: 'Orders entered the warehouse system without a full address; 65% of them arrive late.',
    sql: `SELECT delivery_id AS ref, client_id, order_channel || ' order' ||
                 coalesce(' (email format ' || email_format_id || ')', '') AS detail
          FROM deliveries WHERE address_status = 'incomplete'`,
  },
  {
    id: 'impossible_promise', severity: 'medium', source: 'Order promising',
    title: 'Same-day promised after the 8am pick-list cutoff',
    why: 'The order cannot make that day\'s pick list, so the promise is broken the moment it is made.',
    sql: `SELECT delivery_id AS ref, client_id, 'Received ' || to_char(order_received_ts, 'HH24:MI') AS detail
          FROM deliveries WHERE commitment_type = 'same_day' AND order_received_ts::time >= '08:00'`,
  },
  {
    id: 'stock_flag_conflict', severity: 'medium', source: 'WMS inventory',
    title: 'Nearest warehouse "had stock" but order shipped elsewhere',
    why: 'Either the stock flag is wrong or allocation ignored available stock.',
    sql: `SELECT delivery_id AS ref, client_id, 'Nearest ' || nearest_warehouse_id || ', shipped from ' || fulfilment_warehouse_id AS detail
          FROM deliveries WHERE nearest_warehouse_had_stock = 'Y' AND nearest_warehouse_id <> fulfilment_warehouse_id`,
  },
  {
    id: 'distance_mismatch', severity: 'low', source: 'WMS / routing',
    title: 'Distance far from the warehouse-to-region reference',
    why: 'Recorded mileage is more than 50% and 150 miles away from the reference distance (local runs vary naturally).',
    sql: `SELECT d.delivery_id AS ref, d.client_id, d.distance_miles || ' mi vs reference ' || r.ref || ' mi' AS detail
          FROM deliveries d JOIN (
            SELECT warehouse_id, unnest(ARRAY['Midwest','Southeast','Northeast','West']) AS region,
                   unnest(ARRAY[midwest, southeast, northeast, west]) AS ref FROM warehouse_region_distance) r
            ON r.warehouse_id = d.fulfilment_warehouse_id AND r.region = d.destination_region
          WHERE abs(d.distance_miles - r.ref) > greatest(0.5 * r.ref, 150)`,
  },
  {
    id: 'missing_actual_km', severity: 'low', source: 'Carrier delivery events',
    title: 'Actual route length not recorded',
    why: 'Route efficiency cannot be measured for these deliveries.',
    sql: `SELECT delivery_id AS ref, client_id, 'Carrier ' || carrier_id AS detail FROM deliveries WHERE actual_route_km IS NULL`,
  },
  {
    id: 'route_detour', severity: 'low', source: 'Carrier delivery events',
    title: 'Actual route more than 50% longer than planned',
    why: 'Large detours point at failed attempts, re-routing or bad event data.',
    sql: `SELECT delivery_id AS ref, client_id, round(actual_route_km / planned_route_km, 2) || 'x planned' AS detail
          FROM deliveries WHERE actual_route_km > 1.5 * planned_route_km`,
  },
  {
    id: 'days_late_mismatch', severity: 'medium', source: 'Delivery history',
    title: 'days_late or on_time disagrees with the dates',
    why: 'Derived fields must match delivered minus promised date.',
    sql: `SELECT delivery_id AS ref, client_id, 'days_late ' || days_late || ', dates say ' || (delivered_date - promised_date) AS detail
          FROM deliveries WHERE days_late <> delivered_date - promised_date
             OR (on_time = 'Y') <> (delivered_date <= promised_date)`,
  },
  {
    id: 'timeline_order', severity: 'high', source: 'Delivery history',
    title: 'Events out of order (shipped before received, delivered before shipped)',
    why: 'Impossible timelines mean a clock or keying error.',
    sql: `SELECT delivery_id AS ref, client_id, 'received ' || order_received_ts || ', shipped ' || shipped_ts || ', delivered ' || delivered_date AS detail
          FROM deliveries WHERE shipped_ts < order_received_ts OR delivered_date < shipped_ts::date OR pick_list_date < order_received_ts::date`,
  },
  {
    id: 'flat_redelivery_cost', severity: 'medium', source: 'Finance',
    title: 'Redelivery cost is a flat charge on every late delivery',
    why: 'Every late delivery carries the same redelivery cost, so the field is a rule, not a real re-send.',
    sql: `SELECT delivery_id AS ref, client_id, '$' || redelivery_cost_usd AS detail FROM deliveries
          WHERE redelivery_cost_usd > 0 AND (SELECT count(DISTINCT redelivery_cost_usd) FROM deliveries WHERE redelivery_cost_usd > 0) = 1`,
  },
  {
    id: 'unpenalised_sla_late', severity: 'medium', source: 'Finance',
    title: 'Late delivery for an SLA client with no penalty recorded',
    why: 'Either penalties are still to come, were waived, or are missing from the ledger.',
    sql: `SELECT d.delivery_id AS ref, d.client_id, d.days_late || ' day(s) late' AS detail
          FROM deliveries d JOIN clients c USING (client_id)
          WHERE c.sla_penalty_clause = 'Y' AND d.on_time = 'N'
            AND NOT EXISTS (SELECT 1 FROM sla_penalties p WHERE p.delivery_id = d.delivery_id)`,
  },
  {
    id: 'penalty_without_clause', severity: 'high', source: 'Finance',
    title: 'Penalty paid to a client without a penalty clause',
    why: 'Money paid out with no contractual basis.',
    sql: `SELECT p.penalty_id AS ref, p.client_id, '$' || p.penalty_usd AS detail
          FROM sla_penalties p JOIN clients c USING (client_id) WHERE c.sla_penalty_clause = 'N'`,
  },
  {
    id: 'email_format_mismatch', severity: 'low', source: 'Client order feeds',
    title: 'Email format missing on email orders (or set on others)',
    why: 'Parsing rules are chosen by format; without it the order is keyed by hand.',
    sql: `SELECT delivery_id AS ref, client_id, order_channel || ', format ' || coalesce(email_format_id::text, 'none') AS detail
          FROM deliveries WHERE (order_channel = 'Email') <> (email_format_id IS NOT NULL)`,
  },
];
