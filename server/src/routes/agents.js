// Operations agents API: settings, the six-month replay, and the approval queue.
import { Router } from 'express';
import { one } from '../db.js';
import { carrierStats } from '../stats.js';
import { mlRepository } from '../ml/repository.js';
import { agentsRepository } from '../agents/repository.js';
import { DEFAULT_SETTINGS, validateSettings } from '../agents/settings.js';
import { runReplay } from '../agents/simulator.js';
import { decisionLog } from '../agents/log.js';

const r = Router();

// History the agents run on: loaded once, then shared by every replay and live day.
let worldPromise;
export const world = () => (worldPromise ??= (async () => {
  const [orders, distances, carriers, cs] = await Promise.all([
    agentsRepository.loadOrders(),
    mlRepository.loadDistances(),
    carrierStats(),
    one('SELECT sum(hours_on_delivery_complaints) AS hours FROM cs_time_study'),
  ]);
  return {
    orders,
    distances,
    rates: Object.fromEntries(carriers.map((c) => [c.carrier_id, Number(c.avg_rate)])),
    csComplaintHoursPerWeek: Number(cs?.hours) || 461,
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
    replays.set(key, { settings: v.settings, ...runReplay(w.orders, { settings: v.settings, distances: w.distances, rates: w.rates, csComplaintHoursPerWeek: w.csComplaintHoursPerWeek }) });
  }
  res.json(replays.get(key));
});

r.get('/agents/approvals', async (req, res) => {
  res.json(await decisionLog.list({ runId: req.query.runId, approval: req.query.approval }));
});

r.post('/agents/approvals/:id', async (req, res) => {
  const { approval } = req.body || {};
  if (!['approved', 'rejected'].includes(approval)) return res.status(400).json({ error: 'approval must be "approved" or "rejected"', field: 'approval' });
  const result = await decisionLog.setApproval(Number(req.params.id), approval, 'manager');
  if (!result.row) return res.status(404).json({ error: 'No such decision' });
  res.json(result);
});

export default r;
