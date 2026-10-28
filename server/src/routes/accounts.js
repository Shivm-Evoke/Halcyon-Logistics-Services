// Exceptions control tower (I5), account health (I9) and the what-if simulator (I6).
import { Router } from 'express';
import { q, one, DEMO_NOW } from '../db.js';
import { whatIf } from '../rules.js';
import { getContainer } from '../container.js';
import { RISK_THRESHOLD as HIGH_RISK } from '../ml/ModelRegistry.js';

const r = Router();

// ---------- Exceptions control tower ----------
// In-flight orders at DEMO_NOW, scored by the ML risk model. The evaluation model is used because it
// was trained before September, so it has never seen these outcomes; the real outcome is returned
// as hindsight to check it.
const IN_FLIGHT = `
  SELECT v.delivery_id, v.order_id, v.client_id, c.client_name, c.account_tier, c.sla_penalty_clause,
         c.account_status, v.order_channel, v.commitment_type, v.order_received_ts, v.promised_date,
         v.destination_region, v.nearest_warehouse_id, v.fulfilment_warehouse_id, v.carrier_id,
         v.f_address, v.f_cutoff, v.f_stock, v.f_carrier, v.distance_miles, v.stops_on_route, v.received_hour,
         extract(dow FROM v.order_received_ts)::int AS received_dow,
         v.is_late AS actual_late, v.days_late AS actual_days_late,
         (SELECT max(n.created_at) FROM notifications n WHERE n.delivery_id = v.delivery_id) AS notified_at
  FROM v_deliveries v JOIN clients c USING (client_id)
  WHERE v.order_received_ts <= $1::text::timestamp AND v.delivered_date >= $1::text::date`;

const features = (v) => ({
  order_channel: v.order_channel, commitment_type: v.commitment_type, received_dow: v.received_dow,
  cutoff_breach: +v.f_cutoff, after_cutoff: +(v.received_hour >= 8), address_incomplete: +v.f_address,
  stock_miss: +v.f_stock, carrier_id: v.carrier_id, distance_miles: v.distance_miles,
  destination_region: v.destination_region, fulfilment_warehouse_id: v.fulfilment_warehouse_id,
  account_tier: v.account_tier, sla: +(v.sla_penalty_clause === 'Y'), stops_on_route: v.stops_on_route,
});

r.get('/exceptions', async (_req, res) => {
  const { registry } = await getContainer();
  const scorer = registry.scorer('evaluation');
  const t = process.hrtime.bigint();
  const rows = (await q(IN_FLIGHT, [DEMO_NOW])).map((v) => {
    const { risk, drivers } = scorer.score(features(v));
    // Only reasons present on this order that add at least 3 points of risk.
    return { ...v, risk, drivers: drivers.filter((d) => d.impact >= 0.03 && d.value !== 0).slice(0, 3) };
  });
  const scoringMs = Number(process.hrtime.bigint() - t) / 1e6;
  rows.sort((a, b) => ((b.account_status === 'threatening_to_leave') - (a.account_status === 'threatening_to_leave'))
    || (b.risk - a.risk) || a.promised_date.localeCompare(b.promised_date));
  const high = rows.filter((x) => x.risk >= HIGH_RISK);
  const tp = high.filter((x) => x.actual_late).length;
  const late = rows.filter((x) => x.actual_late).length;
  res.json({
    now: DEMO_NOW,
    threshold: HIGH_RISK,
    model_version: registry.meta.version,
    rows,
    model: { in_flight: rows.length, flagged: high.length, true_positive: tp, actual_late: late,
      precision: high.length ? tp / high.length : 0, recall: late ? tp / late : 0, scoring_ms: scoringMs },
  });
});

r.post('/exceptions/:id/notify', async (req, res) => {
  const d = await one('SELECT client_id FROM deliveries WHERE delivery_id = $1', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'Delivery not found' });
  res.status(201).json(await one(
    `INSERT INTO notifications (delivery_id, client_id, channel, message, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, d.client_id, req.body.channel || 'Email', req.body.message, req.body.created_by || 'Control tower']));
});

r.get('/notifications', async (_req, res) => {
  res.json(await q(`SELECT n.*, c.client_name FROM notifications n JOIN clients c USING (client_id) ORDER BY n.id DESC LIMIT 100`));
});

// ---------- Account health ----------

r.get('/accounts', async (_req, res) => {
  res.json(await q(`
    SELECT c.*, count(v.*) AS deliveries, avg(v.is_late::int) AS late_rate,
           sum(v.is_late::int) AS late,
           (SELECT count(*) FROM complaints k WHERE k.client_id = c.client_id) AS complaints,
           (SELECT coalesce(sum(penalty_usd), 0) FROM sla_penalties p WHERE p.client_id = c.client_id) AS penalties,
           mode() WITHIN GROUP (ORDER BY v.root_cause) FILTER (WHERE v.is_late) AS top_cause
    FROM clients c JOIN v_deliveries v USING (client_id)
    GROUP BY c.client_id
    ORDER BY (c.account_status = 'threatening_to_leave') DESC, c.annual_revenue_usd DESC`));
});

r.get('/accounts/:id', async (req, res) => {
  const id = req.params.id;
  const client = await one('SELECT * FROM clients WHERE client_id = $1', [id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const [summary, monthly, causes, carriers, complaints, notifications] = await Promise.all([
    one(`SELECT count(*) AS deliveries, avg(is_late::int) AS late_rate, sum(is_late::int) AS late,
                avg(f_address::int) AS address_rate, avg(f_cutoff::int) AS cutoff_rate, avg(f_stock::int) AS stock_rate,
                avg(f_carrier::int) AS non_api_share,
                (SELECT coalesce(sum(penalty_usd), 0) FROM sla_penalties WHERE client_id = $1) AS penalties,
                sum(redelivery_cost_usd) AS redelivery
         FROM v_deliveries WHERE client_id = $1`, [id]),
    q(`SELECT to_char(order_received_ts, 'YYYY-MM') AS month, count(*) AS n, avg((NOT is_late)::int) AS on_time_rate
       FROM v_deliveries WHERE client_id = $1 GROUP BY 1 ORDER BY 1`, [id]),
    q(`SELECT root_cause AS cause, count(*) AS late FROM v_deliveries WHERE client_id = $1 AND is_late GROUP BY 1 ORDER BY 2 DESC`, [id]),
    q(`SELECT carrier_id, count(*) AS n, avg(is_late::int) AS late_rate FROM v_deliveries WHERE client_id = $1 GROUP BY 1 ORDER BY 1`, [id]),
    q(`SELECT * FROM complaints WHERE client_id = $1 ORDER BY complaint_date DESC`, [id]),
    q(`SELECT * FROM notifications WHERE client_id = $1 ORDER BY id DESC`, [id]),
  ]);
  res.json({ client, summary, monthly, causes, carriers, complaints, notifications });
});

// ---------- What-if simulator ----------

let groupCache;
r.get('/whatif', async (req, res) => {
  groupCache ??= await q(`
    SELECT v.f_address, v.f_cutoff, v.f_stock, (c.has_api = 'Y') AS has_api,
           count(*) AS n, sum(v.is_late::int) AS late,
           coalesce(sum(p.penalty_usd), 0) AS penalties, sum(v.redelivery_cost_usd) AS redelivery
    FROM v_deliveries v JOIN carriers c USING (carrier_id) LEFT JOIN sla_penalties p USING (delivery_id)
    GROUP BY 1, 2, 3, 4`);
  const on = (k) => req.query[k] === '1' || req.query[k] === 'true';
  const fix = { address: on('address'), cutoff: on('cutoff'), stock: on('stock'), carrier: on('carrier'), routing: on('routing') };
  const scenarios = {
    baseline: whatIf(groupCache, {}),
    selected: whatIf(groupCache, fix),
    routingOnly: whatIf(groupCache, { routing: true }),
    upstreamAll: whatIf(groupCache, { address: true, cutoff: true, stock: true, carrier: true }),
  };
  res.json({ fix, scenarios, vendorCost: 680000, months: 6 });
});

export default r;
