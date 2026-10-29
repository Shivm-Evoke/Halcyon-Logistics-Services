// Operations agents API: settings, the six-month replay, and the approval queue.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getContainer } from '../container.js';
import { one } from '../db.js';
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
