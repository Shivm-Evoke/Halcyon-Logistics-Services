// Operations agents API: settings, the six-month replay, and the approval queue.
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getContainer } from '../container.js';
import { one, q } from '../db.js';
import { carrierStats } from '../stats.js';
import { mlRepository } from '../ml/repository.js';
import { agentsRepository } from '../agents/repository.js';
import { DEFAULT_SETTINGS, validateSettings } from '../agents/settings.js';
import { runReplay, buildWorld, dayOf } from '../agents/simulator.js';
import { parseDataset, REQUIRED_COLUMNS, OPTIONAL_COLUMNS } from '../agents/datasets.js';
import { datasetStore } from '../agents/datasetStore.js';
import { decisionLog } from '../agents/log.js';
import { LiveDay, pickDemoDay } from '../agents/liveDay.js';

export const RECORDED_FILE = process.env.RECORDED_DAY_FILE || path.resolve(import.meta.dirname, '../../data/recorded-day.json');

const r = Router();

// History the agents run on: loaded once, then shared by every replay and live day.
let worldPromise;
export const world = () => (worldPromise ??= (async () => {
  const [orders, distances, carriers, cs, penalty] = await Promise.all([
    agentsRepository.loadOrders(),
    mlRepository.loadDistances(),
    carrierStats(),
    one('SELECT sum(hours_on_delivery_complaints) AS hours FROM cs_time_study'),
    one(`SELECT (SELECT sum(penalty_usd) FROM sla_penalties) / NULLIF(count(*), 0) AS per_late_sla
         FROM deliveries d JOIN clients c USING (client_id) WHERE d.on_time = 'N' AND c.sla_penalty_clause = 'Y'`),
  ]);
  return {
    orders,
    distances,
    rates: Object.fromEntries(carriers.map((c) => [c.carrier_id, Number(c.avg_rate)])),
    csComplaintHoursPerWeek: Number(cs?.hours) || 461,
    penaltyUsdPerLateSla: Number(penalty?.per_late_sla) || undefined,
  };
})().catch((e) => { worldPromise = undefined; throw e; }));

const replays = new Map(); // settings + dataset -> result; a replay takes under a second, so a few are kept
const datasetOrders = new Map(); // dataset id -> orders, read once

/** Orders to run on: the history, or a test dataset judged by the history's yardstick. 404 when the dataset is unknown. */
async function ordersFor(dataset, settings) {
  const w = await world();
  if (dataset == null || dataset === '') return { w, orders: w.orders, worldFor: null };
  const id = Number(dataset);
  if (!datasetOrders.has(id)) {
    const orders = Number.isInteger(id) ? await datasetStore.orders(id) : null;
    if (!orders) return { w, orders: null };
    datasetOrders.set(id, orders);
  }
  return { w, orders: datasetOrders.get(id), history: w.orders, worldFor: (settings) => buildWorld(w.orders, settings) };
}

r.get('/agents/settings', (_req, res) => res.json({ defaults: DEFAULT_SETTINGS }));

r.post('/agents/replay', async (req, res) => {
  const { dataset, ...input } = req.body || {};
  const v = validateSettings(input);
  if (!v.ok) return res.status(400).json({ error: v.message, field: v.field });
  const key = JSON.stringify([v.settings, dataset ?? null]);
  if (!replays.has(key)) {
    const { w, orders, history, worldFor } = await ordersFor(dataset, v.settings);
    if (!orders) return res.status(404).json({ error: `No test dataset ${dataset}`, field: 'dataset' });
    if (replays.size >= 20) replays.delete(replays.keys().next().value);
    replays.set(key, { settings: v.settings, dataset: dataset ?? null, ...runReplay(orders, {
      settings: v.settings, distances: w.distances, rates: w.rates, csComplaintHoursPerWeek: w.csComplaintHoursPerWeek,
      penaltyUsdPerLateSla: w.penaltyUsdPerLateSla, world: worldFor?.(v.settings) ?? null, history: history ?? [],
    }) });
  }
  res.json(replays.get(key));
});

// ---------- Test datasets: upload a CSV of orders for the agents to run on ----------
const clientMap = async () => new Map((await q('SELECT client_id, client_name, account_tier, sla_penalty_clause, account_status FROM clients')).map((c) => [c.client_id, c]));

r.get('/agents/datasets', async (_req, res) => res.json({ datasets: await datasetStore.list(), required: REQUIRED_COLUMNS, optional: OPTIONAL_COLUMNS }));

// Body: the CSV itself (Content-Type text/csv, name in ?name=), or JSON { name, csv }.
r.post('/agents/datasets', express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' }), async (req, res) => {
  const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
  const name = String((typeof req.body === 'string' ? req.query.name : req.body?.name) || '').trim().slice(0, 80) || `Test data ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  if (!csv) return res.status(400).json({ error: 'Send a CSV file', field: 'csv' });
  const parsed = parseDataset(csv, { clients: await clientMap() });
  if (parsed.error) return res.status(400).json({ error: parsed.error, missing: parsed.missing, rejected: parsed.rejected.slice(0, 100), rejectedCount: parsed.rejected.length });
  const saved = await datasetStore.save({ name, ...parsed });
  res.status(201).json({ ...saved, accepted: parsed.orders.length, rejected: parsed.rejected.slice(0, 100), rejectedCount: parsed.rejected.length });
});

// A ready-made week of dummy orders: a real week of history moved six weeks ahead, new ids, outcomes left blank.
r.get('/agents/datasets/sample.csv', async (_req, res) => {
  const w = await world();
  const from = '2026-09-21', to = '2026-09-27';
  const shift = (ts) => { const d = new Date(`${ts.slice(0, 10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 42); return `${d.toISOString().slice(0, 10)}${ts.slice(10)}`; };
  const cols = ['delivery_id', ...REQUIRED_COLUMNS, 'order_channel', 'fulfilment_warehouse_id', 'carrier_rate_usd', 'on_time'];
  const lines = w.orders.filter((o) => dayOf(o) >= from && dayOf(o) <= to).map((o, i) => [
    `T${String(i + 1).padStart(5, '0')}`, o.client_id, shift(o.received_ts), o.commitment_type, o.address_incomplete ? 'incomplete' : 'complete',
    o.destination_region, o.nearest_warehouse_id, o.stock_miss ? 'N' : 'Y', o.distance_miles, o.carrier_id, o.order_channel,
    o.fulfilment_warehouse_id, o.carrier_rate_usd ?? '', '',
  ].join(','));
  res.type('text/csv').attachment('halcyon-test-week.csv').send([cols.join(','), ...lines].join('\n'));
});

r.get('/agents/approvals', async (req, res) => {
  res.json(await decisionLog.list({ runId: req.query.runId, approval: req.query.approval, agent: req.query.agent, limit: Math.min(500, Number(req.query.limit) || 500) }));
});

r.post('/agents/approvals/:id', async (req, res) => {
  const { approval } = req.body || {};
  if (!['approved', 'rejected'].includes(approval)) return res.status(400).json({ error: 'approval must be "approved" or "rejected"', field: 'approval' });
  const actor = typeof req.body?.actor === 'string' && req.body.actor.trim() ? req.body.actor.trim().slice(0, 40) : 'manager';
  const result = await decisionLog.setApproval(Number(req.params.id), approval, actor);
  if (!result.row) return res.status(404).json({ error: 'No such decision' });
  // A parked step of a demo order's golden thread carries on once decided (loaded lazily: the thread needs this module's world).
  if (result.changed && result.row.run_id === 'thread') {
    const { getThread } = await import('../orders/service.js');
    await (await getThread()).thread.resume(result.row);
  }
  res.json(result);
});

// The five measured causes of lateness and the evidence against routing, for the "Why we're late" screen.
let causes;
r.get('/agents/causes', async (_req, res) => {
  causes ??= (async () => {
    const [base, cutoff, carriers, friday, address, stock, routing, money, detour] = await Promise.all([
      one(`SELECT count(*) AS orders, avg((on_time = 'Y')::int) AS on_time FROM deliveries`),
      q(`SELECT (extract(hour FROM order_received_ts) >= 8) AS after_cutoff, count(*) AS orders, avg((on_time = 'Y')::int) AS on_time
         FROM deliveries WHERE commitment_type = 'same_day' GROUP BY 1 ORDER BY 1`),
      q(`SELECT carrier_id, count(*) AS orders, avg((on_time = 'Y')::int) AS on_time FROM deliveries
         WHERE address_status = 'complete' AND nearest_warehouse_had_stock = 'Y' AND distance_miles < 300
           AND NOT (commitment_type = 'same_day' AND extract(hour FROM order_received_ts) >= 8) GROUP BY 1 ORDER BY 1`),
      q(`SELECT (extract(isodow FROM order_received_ts) = 5) AS friday, count(*) AS orders, avg((carrier_id = 'D')::int) AS share_d, avg((on_time = 'Y')::int) AS on_time
         FROM deliveries GROUP BY 1 ORDER BY 1`),
      q(`SELECT order_channel, count(*) AS orders, avg((address_status = 'incomplete')::int) AS incomplete_share,
              avg((on_time = 'Y')::int) FILTER (WHERE address_status = 'incomplete') AS on_time_incomplete FROM deliveries GROUP BY 1 ORDER BY 1`),
      q(`SELECT nearest_warehouse_had_stock AS had_stock, count(*) AS orders, avg(distance_miles) AS miles, avg((on_time = 'Y')::int) AS on_time
         FROM deliveries GROUP BY 1 ORDER BY 1`),
      q(`SELECT width_bucket(stops_on_route, 0, 40, 4) AS band, min(stops_on_route) AS min_stops, max(stops_on_route) AS max_stops,
              avg((on_time = 'Y')::int) AS on_time, avg(actual_route_km / NULLIF(planned_route_km, 0)) AS actual_vs_planned
         FROM deliveries WHERE address_status = 'complete' AND nearest_warehouse_had_stock = 'Y'
           AND NOT (commitment_type = 'same_day' AND extract(hour FROM order_received_ts) >= 8) GROUP BY 1 ORDER BY 1`),
      one(`SELECT (SELECT sum(penalty_usd) FROM sla_penalties) AS penalties, (SELECT sum(redelivery_cost_usd) FROM deliveries) AS redelivery,
              (SELECT count(*) FROM clients WHERE account_status = 'threatening_to_leave') AS at_risk_clients,
              (SELECT sum(annual_revenue_usd) FROM clients WHERE account_status = 'threatening_to_leave') AS at_risk_revenue,
              (SELECT sum(hours_on_delivery_complaints) FROM cs_time_study) AS complaint_hours, (SELECT sum(hours_total) FROM cs_time_study) AS cs_hours`),
      // Route execution: how far trucks drove over plan, late against on-time, on clean orders (no address, cutoff or stock
      // issue). actual_route_km is recorded after the trip, so this shows correlation, not cause.
      one(`SELECT avg(actual_route_km / NULLIF(planned_route_km, 0) - 1) FILTER (WHERE is_late AND NOT (f_address OR f_cutoff OR f_stock)) AS clean_late,
              avg(actual_route_km / NULLIF(planned_route_km, 0) - 1) FILTER (WHERE NOT is_late AND NOT (f_address OR f_cutoff OR f_stock)) AS clean_on_time,
              count(*) FILTER (WHERE actual_route_km / NULLIF(planned_route_km, 0) > 1.2) AS over20,
              avg((NOT is_late)::int) FILTER (WHERE actual_route_km / NULLIF(planned_route_km, 0) > 1.2) AS over20_on_time,
              count(*) FILTER (WHERE root_cause = 'residual') AS detour_only_late,
              count(*) FILTER (WHERE is_late AND NOT (f_address OR f_cutoff OR f_stock) AND actual_route_km / NULLIF(planned_route_km, 0) > 1.2) AS detour_late_incl_carrier,
              count(*) FILTER (WHERE is_late) AS late, count(*) AS deliveries
         FROM v_deliveries`),
    ]);
    return { base, cutoff, carriers, friday, address, stock, routing, money, detour };
  })().catch((e) => { causes = undefined; throw e; });
  res.json(await causes);
});

// ---------- Live operations day: one run at a time, kept on the server so a refresh or a second tab resumes it ----------
let live = null;
const MODES = ['live', 'recorded'];
const readRecording = () => { try { return JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8')); } catch { return null; } };
const liveRun = (req, res) => {
  if (!live || live.runId !== req.params.runId) { res.status(404).json({ error: 'No such live run; start a new one' }); return null; }
  return live;
};

r.post('/agents/live', async (req, res) => {
  const mode = req.body?.mode ?? 'live';
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'mode must be "live" or "recorded"', field: 'mode' });
  const v = validateSettings(req.body?.settings || {});
  if (!v.ok) return res.status(400).json({ error: v.message, field: v.field });
  const dataset = req.body?.dataset ?? null;
  const [{ w, orders, history, worldFor }, { claude }] = await Promise.all([ordersFor(dataset, v.settings), getContainer()]);
  if (!orders) return res.status(404).json({ error: `No test dataset ${dataset}`, field: 'dataset' });
  // A recording is for one day of the history; without one (or on test data), reasons come from the rules.
  const recorded = mode === 'recorded' && dataset == null ? readRecording() : null;
  const day = req.body?.day || recorded?.day || pickDemoDay(orders);
  if (!orders.some((o) => dayOf(o) === day)) return res.status(400).json({ error: `No orders on ${day}`, field: 'day' });
  const name = dataset == null ? null : (await datasetStore.list()).find((d) => d.id === Number(dataset))?.name;
  const label = name ? `Test data: ${name}` : 'The worst Friday of September';
  live = new LiveDay({ day, orders, distances: w.distances, rates: w.rates, settings: v.settings, claude, log: decisionLog, mode, recorded, world: worldFor?.(v.settings) ?? null, history: history ?? [], label, dataset });
  res.json({ runId: live.runId, day, mode, dataset, label, hasRecording: Boolean(recorded) });
});

r.get('/agents/live/current', (_req, res) => (live ? res.json({ runId: live.runId }) : res.status(404).json({ error: 'No live run' })));

r.get('/agents/live/:runId', async (req, res) => {
  const run = liveRun(req, res);
  if (run) res.json(await run.state());
});

r.post('/agents/live/:runId/advance', async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return res.status(400).json({ error: 'minutes must be a whole number from 1 to 1440', field: 'minutes' });
  const run = liveRun(req, res);
  if (run) res.json(await run.advance(minutes));
});

// Saves this run's Claude output as the stage backup for recorded mode.
r.post('/agents/live/:runId/record', async (req, res) => {
  const run = liveRun(req, res);
  if (!run) return;
  if (run.mode !== 'live') return res.status(400).json({ error: 'Only a live run can be recorded' });
  await run.idle();
  const recording = run.recording();
  fs.mkdirSync(path.dirname(RECORDED_FILE), { recursive: true });
  fs.writeFileSync(RECORDED_FILE, JSON.stringify(recording, null, 2));
  res.json({ saved: RECORDED_FILE, reasons: Object.keys(recording.reasons).length, briefings: Object.keys(recording.briefings).length });
});

export default r;
