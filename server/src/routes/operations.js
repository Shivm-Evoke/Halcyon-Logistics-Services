// Inventory placement (I3) and carrier scorecard (I4).
import { Router } from 'express';
import { q, one } from '../db.js';
import { carrierStats } from '../stats.js';
import { rankCarriers, TIME_CRITICAL_MAX_LATE, REDELIVERY_USD, PENALTY_USD } from '../rules.js';

const r = Router();

// ---------- Inventory placement ----------

r.get('/inventory/overview', async (_req, res) => {
  const [matrix, monthly, byWarehouse, clients, transfers] = await Promise.all([
    q(`SELECT nearest_warehouse_id AS nearest, fulfilment_warehouse_id AS shipped_from, count(*) AS n,
              avg(distance_miles) AS miles, avg(is_late::int) AS late_rate
       FROM v_deliveries WHERE f_stock GROUP BY 1, 2 ORDER BY 1, 2`),
    q(`SELECT to_char(order_received_ts, 'YYYY-MM') AS month, nearest_warehouse_id AS warehouse, count(*) AS misses
       FROM v_deliveries WHERE f_stock GROUP BY 1, 2 ORDER BY 1, 2`),
    q(`SELECT nearest_warehouse_id AS warehouse, count(*) AS demand, sum(f_stock::int) AS misses,
              avg(f_stock::int) AS miss_rate, avg(is_late::int) FILTER (WHERE f_stock) AS late_if_miss,
              avg(is_late::int) FILTER (WHERE NOT f_stock) AS late_if_hit
       FROM v_deliveries GROUP BY 1 ORDER BY 1`),
    // For each client, the warehouse where they miss stock most and a safety-stock recommendation:
    // cover 1.5x the average monthly misses there (six months of history).
    q(`WITH m AS (
         SELECT client_id, nearest_warehouse_id AS warehouse_id, count(*) AS demand, sum(f_stock::int) AS misses,
                sum(f_stock::int) FILTER (WHERE is_late) AS late_misses
         FROM v_deliveries GROUP BY 1, 2),
       ranked AS (SELECT *, row_number() OVER (PARTITION BY client_id ORDER BY misses DESC) AS rk FROM m)
       SELECT r.client_id, c.client_name, c.account_tier, c.account_status, r.warehouse_id, r.demand, r.misses,
              r.misses::numeric / r.demand AS miss_rate, r.late_misses,
              ceil(r.misses / 6.0 * 1.5)::int AS recommended_units,
              EXISTS (SELECT 1 FROM stock_transfers t WHERE t.client_id = r.client_id AND t.warehouse_id = r.warehouse_id) AS planned
       FROM ranked r JOIN clients c USING (client_id)
       WHERE rk = 1 AND r.misses > 0
       ORDER BY (c.account_status = 'threatening_to_leave') DESC, r.late_misses DESC LIMIT 60`),
    q(`SELECT t.*, c.client_name FROM stock_transfers t JOIN clients c USING (client_id) ORDER BY t.id DESC`),
  ]);
  res.json({ matrix, monthly, byWarehouse, clients, transfers });
});

r.post('/inventory/transfers', async (req, res) => {
  const { client_id, warehouse_id, units, reason } = req.body;
  if (!client_id || !warehouse_id || !(units > 0)) return res.status(400).json({ error: 'client_id, warehouse_id and units are required' });
  res.status(201).json(await one(
    `INSERT INTO stock_transfers (client_id, warehouse_id, units, reason) VALUES ($1,$2,$3,$4) RETURNING *`,
    [client_id, warehouse_id, units, reason || 'Safety stock at nearest warehouse']));
});

// ---------- Carrier scorecard ----------

r.get('/carriers/scorecard', async (_req, res) => {
  const [stats, lateness, share, misallocated] = await Promise.all([
    carrierStats(),
    q(`SELECT carrier_id, days_late, count(*) AS n FROM v_deliveries
       WHERE NOT (f_address OR f_cutoff OR f_stock) AND days_late > 0 GROUP BY 1, 2 ORDER BY 1, 2`),
    q(`SELECT to_char(order_received_ts, 'YYYY-MM') AS month, carrier_id, count(*) AS n
       FROM v_deliveries GROUP BY 1, 2 ORDER BY 1, 2`),
    one(`SELECT count(*) FILTER (WHERE f_carrier) AS to_non_api, count(*) AS time_critical
         FROM v_deliveries WHERE commitment_type <> 'standard'`),
  ]);
  const scored = stats.map((c) => ({
    ...c,
    // Rate plus the expected cost of lateness for an SLA client (redelivery + penalty).
    expected_cost_sla: Number(c.avg_rate) + Number(c.clean_late_rate) * (REDELIVERY_USD + PENALTY_USD),
    time_critical_eligible: Number(c.clean_late_rate) <= TIME_CRITICAL_MAX_LATE,
  }));
  res.json({ carriers: scored, lateness, share, misallocated, threshold: TIME_CRITICAL_MAX_LATE });
});

r.post('/carriers/recommend', async (req, res) => {
  const client = await one('SELECT * FROM clients WHERE client_id = $1', [req.body.client_id]);
  res.json(rankCarriers(await carrierStats(), {
    slaClient: client?.sla_penalty_clause === 'Y', commitmentType: req.body.commitment_type || 'standard',
  }));
});

export default r;
