import { Router } from 'express';
import { q, one } from '../db.js';
import { carrierStats } from '../stats.js';

const r = Router();

r.get('/overview', async (_req, res) => {
  const [kpis, monthly, causes, byRegion, byWarehouse, cs, carriers] = await Promise.all([
    one(`
      SELECT count(*) AS deliveries,
             avg((NOT is_late)::int) AS on_time_rate,
             sum(is_late::int) AS late,
             (SELECT sum(penalty_usd) FROM sla_penalties) AS penalties,
             sum(redelivery_cost_usd) AS redelivery,
             (SELECT count(*) FROM complaints) AS complaints,
             (SELECT count(*) FROM clients WHERE account_status = 'threatening_to_leave') AS at_risk_accounts,
             (SELECT sum(annual_revenue_usd) FROM clients WHERE account_status = 'threatening_to_leave') AS at_risk_revenue
      FROM v_deliveries`),
    q(`SELECT to_char(order_received_ts, 'YYYY-MM') AS month, count(*) AS deliveries,
              avg((NOT is_late)::int) AS on_time_rate
       FROM v_deliveries GROUP BY 1 ORDER BY 1`),
    q(`SELECT v.root_cause AS cause, count(*) AS late,
              coalesce(sum(p.penalty_usd), 0) AS penalties, sum(v.redelivery_cost_usd) AS redelivery
       FROM v_deliveries v LEFT JOIN sla_penalties p USING (delivery_id)
       WHERE v.is_late GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT destination_region AS name, avg(is_late::int) AS late_rate, count(*) AS n
       FROM v_deliveries GROUP BY 1 ORDER BY 1`),
    q(`SELECT fulfilment_warehouse_id AS name, avg(is_late::int) AS late_rate, count(*) AS n
       FROM v_deliveries GROUP BY 1 ORDER BY 1`),
    one(`SELECT sum(hours_total) AS total, sum(hours_on_delivery_complaints) AS complaints,
                sum(hours_keying_email_orders) AS keying, sum(hours_on_proactive_client_work) AS proactive
         FROM cs_time_study`),
    carrierStats(),
  ]);
  res.json({ kpis, monthly, causes, byRegion, byWarehouse, cs, carriers });
});

r.get('/diagnosis', async (_req, res) => {
  const factor = (flag) => q(`
    SELECT ${flag} AS present, avg(is_late::int) AS late_rate, count(*) AS n
    FROM v_deliveries GROUP BY 1 ORDER BY 1`);
  const [address, cutoff, stock, carrier, sameDayByHour, channel, distance, routeRatio, stops] = await Promise.all([
    factor('f_address'), factor('f_cutoff'), factor('f_stock'), factor('f_carrier'),
    q(`SELECT received_hour AS hour, avg(is_late::int) AS late_rate, count(*) AS n
       FROM v_deliveries WHERE commitment_type = 'same_day' GROUP BY 1 ORDER BY 1`),
    q(`SELECT order_channel AS channel, avg(f_address::int) AS incomplete_rate, avg(is_late::int) AS late_rate, count(*) AS n
       FROM v_deliveries GROUP BY 1 ORDER BY 1`),
    q(`SELECT CASE WHEN distance_miles <= 200 THEN '0–200' WHEN distance_miles <= 500 THEN '200–500'
                   WHEN distance_miles <= 1000 THEN '500–1,000' ELSE '1,000+' END AS band,
              min(distance_miles) AS lo, avg(is_late::int) AS late_rate, count(*) AS n
       FROM v_deliveries GROUP BY 1 ORDER BY 2`),
    q(`SELECT carrier_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_route_km / planned_route_km) AS ratio
       FROM v_deliveries WHERE actual_route_km IS NOT NULL GROUP BY 1 ORDER BY 1`),
    q(`SELECT (stops_on_route - 1) / 10 * 10 + 1 || '–' || ((stops_on_route - 1) / 10 + 1) * 10 AS band,
              avg(is_late::int) AS late_rate, count(*) AS n
       FROM v_deliveries GROUP BY 1, (stops_on_route - 1) / 10 ORDER BY (stops_on_route - 1) / 10`),
  ]);
  res.json({ factors: { address, cutoff, stock, carrier }, sameDayByHour, channel, distance, routeRatio, stops });
});

// Every dataset the app runs on, with live row counts, for the "Start here" screen.
r.get('/datasets', async (_req, res) => {
  const count = (t) => one(`SELECT count(*) AS n FROM ${t}`).then((x) => x.n);
  const [deliveries, clients, carriers, warehouses, penalties, complaints, timeStudy, messages, inboundOrders] = await Promise.all([
    count('deliveries'), count('clients'), count('carriers'), count('warehouses'), count('sla_penalties'), count('complaints'),
    count('cs_time_study'), count('inbound_messages'), count('inbound_orders'),
  ]);
  res.json({
    supplied: [
      { name: 'Deliveries', file: 'deliveries.csv', rows: deliveries, what: 'Every delivery Apr–Sep 2026: order, channel, promise, warehouse, carrier, outcome' },
      { name: 'Clients', file: 'clients.csv', rows: clients, what: 'Tier, revenue, SLA penalty clause, threatening to leave' },
      { name: 'Carriers', file: 'carriers.csv', rows: carriers, what: 'Rates, API or not, preferred-supplier deal' },
      { name: 'Warehouses', file: 'warehouses.csv', rows: warehouses, what: 'Region, 8am pick-list cutoff, collection window' },
      { name: 'SLA penalties', file: 'sla_penalties.csv', rows: penalties, what: '$180 per late SLA delivery' },
      { name: 'Complaints', file: 'complaints.csv', rows: complaints, what: 'Formal complaints, last 90 days' },
      { name: 'CS time study', file: 'customer_success_time_study.csv', rows: timeStudy, what: 'One week of customer success hours' },
    ],
    received: { messages, inbound_orders: inboundOrders },
  });
});

export default r;
