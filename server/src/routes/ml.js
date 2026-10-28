// Model and data-quality API: metrics, explanations, real-time scoring, decisions and data checks.
import { Router } from 'express';
import { getContainer } from '../container.js';
import { FEATURE_LABELS } from '../ml/features.js';

const r = Router();
const MAX_BATCH = 10000;

// Microseconds spent in fn, so responses can report their own model latency.
const timed = (fn) => {
  const t = process.hrtime.bigint();
  const value = fn();
  return { value, us: Number(process.hrtime.bigint() - t) / 1000 };
};

r.get('/ml/model', async (_req, res) => {
  const { registry } = await getContainer();
  const { backtest, ...meta } = registry.meta;
  res.json({
    meta,
    labels: FEATURE_LABELS,
    importance: registry.models.production.importance(),
    coefficients: registry.coefficients(),
  });
});

r.get('/ml/backtest', async (_req, res) => res.json((await getContainer()).registry.meta.backtest));

r.post('/ml/retrain', async (_req, res) => {
  const c = await getContainer();
  await c.registry.train();
  c.scanner.invalidate();
  c.capacitySimulator.cache.clear();
  res.json({ version: c.registry.meta.version, train_ms: c.registry.meta.train_ms, auc: c.registry.meta.test.auc });
});

// Score one order ({ order }) or many ({ orders: [] }).
r.post('/ml/score', async (req, res) => {
  const scorer = (await getContainer()).registry.scorer();
  if (Array.isArray(req.body.orders)) {
    if (req.body.orders.length > MAX_BATCH) return res.status(413).json({ error: `At most ${MAX_BATCH} orders per batch` });
    const { value, us } = timed(() => req.body.orders.map((o) => scorer.risk(o)));
    return res.json({ risks: value, latency_us: us, per_order_us: us / (value.length || 1) });
  }
  const { value, us } = timed(() => scorer.score(req.body.order || {}));
  res.json({ ...value, latency_us: us });
});

// Optional body.used = { carrierId: ordersAlreadyAssignedToday } applies today's carrier capacity.
r.post('/ml/decide', async (req, res) => {
  const c = await getContainer();
  const capacity = req.body.used ? c.registry.capacity.forDay(req.body.day_volume || c.avgDailyOrders, req.body.used) : undefined;
  const { value, us } = timed(() => c.nextBestAction().decide(req.body.order || {}, { capacity }));
  res.json({ ...value, capacity: capacity && { limits: capacity.limits, usage: capacity.usage }, latency_us: us });
});

// Re-run the backtest with a different capacity policy: ?max_share=0.4&headroom=0.25
r.get('/ml/capacity', async (req, res) => {
  const c = await getContainer();
  const maxShare = Number(req.query.max_share ?? c.registry.capacity.maxShare);
  const headroom = Number(req.query.headroom ?? c.registry.capacity.headroom);
  if (!(maxShare > 0 && maxShare <= 1) || !(headroom >= 0 && headroom <= 3)) {
    return res.status(400).json({ error: 'max_share must be in (0, 1] and headroom in [0, 3]' });
  }
  const t = performance.now();
  const result = c.capacitySimulator.run({ maxShare, headroom });
  res.json({ ...result, avg_daily_orders: c.avgDailyOrders, ms: performance.now() - t });
});

// ---------- Data quality ----------

r.get('/quality/scan', async (_req, res) => res.json(await (await getContainer()).scanner.scan()));

r.get('/quality/checks/:id', async (req, res) => {
  const rows = await (await getContainer()).scanner.rows(req.params.id);
  if (!rows) return res.status(404).json({ error: 'Unknown check' });
  res.json(rows);
});

r.get('/quality/anomalies', async (req, res) => {
  const report = (await getContainer()).anomalies.scanIncoming();
  const code = req.query.code;
  const rows = code ? report.rows.filter((x) => x.findings.some((f) => f.code === code)) : report.rows;
  res.json({ ...report, rows: rows.slice(0, 300), matching: rows.length });
});

r.post('/quality/inspect', async (req, res) => {
  const anomalies = (await getContainer()).anomalies;
  const { value, us } = timed(() => anomalies.inspect(req.body.order || {}, { addressIssues: req.body.address_issues }));
  res.json({ ...value, latency_us: us });
});

export default r;
