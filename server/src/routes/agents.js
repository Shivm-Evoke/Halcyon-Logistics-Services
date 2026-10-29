// Operations agents API: settings, the six-month replay, and the approval queue.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getContainer } from '../container.js';
import { one, q } from '../db.js';
import { carrierStats } from '../stats.js';
import { mlRepository } from '../ml/repository.js';
import { agentsRepository } from '../agents/repository.js';
import { DEFAULT_SETTINGS, validateSettings } from '../agents/settings.js';
import { runReplay } from '../agents/simulator.js';
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

const replays = new Map(); // settings JSON -> result; a replay takes under a second, so a few are kept

r.get('/agents/settings', (_req, res) => res.json({ defaults: DEFAULT_SETTINGS }));

r.post('/agents/replay', async (req, res) => {
  const v = validateSettings(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.message, field: v.field });
  const key = JSON.stringify(v.settings);
  if (!replays.has(key)) {
    const w = await world();
    if (replays.size >= 20) replays.delete(replays.keys().next().value);
    replays.set(key, { settings: v.settings, ...runReplay(w.orders, { settings: v.settings, distances: w.distances, rates: w.rates, csComplaintHoursPerWeek: w.csComplaintHoursPerWeek, penaltyUsdPerLateSla: w.penaltyUsdPerLateSla }) });
  }
  res.json(replays.get(key));
});

r.get('/agents/approvals', async (req, res) => {
  res.json(await decisionLog.list({ runId: req.query.runId, approval: req.query.approval, agent: req.query.agent, limit: Math.min(500, Number(req.query.limit) || 500) }));
});

r.post('/agents/approvals/:id', async (req, res) => {
  const { approval } = req.body || {};
  if (!['approved', 'rejected'].includes(approval)) return res.status(400).json({ error: 'approval must be "approved" or "rejected"', field: 'approval' });
  const result = await decisionLog.setApproval(Number(req.params.id), approval, 'manager');
  if (!result.row) return res.status(404).json({ error: 'No such decision' });
  res.json(result);
});

// The five measured causes of lateness and the evidence against routing, for the "Why we're late" screen.
let causes;
r.get('/agents/causes', async (_req, res) => {
  causes ??= (async () => {
    const [base, cutoff, carriers, friday, address, stock, routing, money] = await Promise.all([
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
    ]);
    return { base, cutoff, carriers, friday, address, stock, routing, money };
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
  const [w, { claude }] = await Promise.all([world(), getContainer()]);
  const recorded = mode === 'recorded' ? readRecording() : null;
  // A recording is for one day; without one, recorded mode still runs with rule-based reasons.
  const day = recorded?.day || pickDemoDay(w.orders);
  live = new LiveDay({ day, orders: w.orders, distances: w.distances, rates: w.rates, settings: v.settings, claude, log: decisionLog, mode, recorded });
  res.json({ runId: live.runId, day, mode, hasRecording: Boolean(recorded) });
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
