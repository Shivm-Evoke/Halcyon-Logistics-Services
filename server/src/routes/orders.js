// Three-sided demo: a client portal posting orders, the ops console acting on them, and a public tracking page for the
// recipient, all reading one order event log. Everything here is a demo: no real login, email or SMS.
// Only /track/* is open without the site password (see index.js); it needs the order's unguessable token.
import { Router } from 'express';
import { q } from '../db.js';
import { getContainer } from '../container.js';
import { getThread } from '../orders/service.js';
import { publicView } from '../orders/thread.js';
import { appendEvent, timeline, getOrder, getOrderByToken, listDemoOrders, threadOrder, newToken, ref } from '../orders/events.js';

const r = Router();
const DEMO_CLIENT = 'C190';
const SIM_EVENTS = ['shipped', 'delayed', 'delivered'];

const errorsOf = (issues) => issues.filter((i) => ['error', 'fatal'].includes(i.severity));
const holdTemplate = (o, issues) => `Order ${o.ref} is on hold: ${errorsOf(issues).map((i) => i.message).join('; ')}. `
  + 'Correct it in your portal and it is released straight away.';

/** Released (or still held) after intake or a fix: write the outcome and, when released, run the golden thread. */
async function afterIntake(id, issues, { fixedBy = null } = {}) {
  const { thread, distances, claude } = await getThread();
  const o = threadOrder(await getOrder(id), distances);
  if (o.status === 'held') {
    await appendEvent(id, 'intake_agent', 'held', { issues: errorsOf(issues).map((i) => i.message) });
    const notice = claude?.writeNotice
      ? await claude.writeNotice({ order: o.ref, problem: errorsOf(issues).map((i) => i.message), action: 'client corrects it in the portal' }, holdTemplate(o, issues))
      : { text: holdTemplate(o, issues), source: 'rules only' };
    await appendEvent(id, 'intake_agent', 'client_notified', { message: notice.text, source: notice.source, channel: 'Portal inbox (demo)', fix: true });
    return o;
  }
  if (['rejected', 'duplicate'].includes(o.status)) {
    await appendEvent(id, 'intake_agent', 'rejected', { issues: errorsOf(issues).map((i) => i.message) });
    return o;
  }
  if (fixedBy) await appendEvent(id, fixedBy, 'client_fixed', {});
  const auto = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  await appendEvent(id, 'intake_agent', 'released', { commitment_type: o.commitment_type, promised_date: o.promised_date, notes: auto });
  await thread.release(o);
  return o;
}

const withTimeline = async (row) => ({ ...row, ref: ref(row.id), events: await timeline(row.id) });

// ---------- Client portal ----------

r.post('/orders', async (req, res) => {
  const clientId = req.body?.client_id || DEMO_CLIENT;
  const order = req.body?.order;
  if (!order) return res.status(400).json({ error: 'order is required', field: 'order' });
  const { ingest } = await getContainer();
  const result = await ingest.api(clientId, [{ client_order_ref: order.client_order_ref || `PORTAL-${Date.now().toString(36).toUpperCase()}`, ...order }]);
  const placed = result.orders[0];
  const id = Number(placed.ref.slice(3));
  await q('UPDATE inbound_orders SET demo = true, tracking_token = $2 WHERE id = $1', [id, newToken()]);
  await appendEvent(id, 'client', 'received', { channel: 'Client portal', service: order.service, received_at: order.received_at });
  if (placed.status === 'corrected') await appendEvent(id, 'intake_agent', 'auto_fixed', { corrections: placed.corrections });
  await afterIntake(id, placed.issues);
  res.status(201).json(await withTimeline(await getOrder(id)));
});

r.get('/orders', async (req, res) => {
  res.json(await Promise.all((await listDemoOrders(req.query.client || null)).map(withTimeline)));
});

r.get('/orders/:id/timeline', async (req, res) => {
  const row = await getOrder(Number(req.params.id));
  if (!row?.demo) return res.status(404).json({ error: 'No such demo order' });
  res.json(await withTimeline(row));
});

/** Re-validates a held order with the corrected address. Returns { status, error } or { order } (the row after the fix). */
async function fixAddress(id, shipTo, actor) {
  const row = await getOrder(id);
  if (!row?.demo) return { status: 404, error: 'No such demo order' };
  if (row.status !== 'held') return { status: 409, error: 'Only a held order can be corrected' };
  const { pipeline } = (await getContainer()).ingest;
  const result = await pipeline.reprocess(id, { ship_to: shipTo || {} });
  await afterIntake(id, result.issues, { fixedBy: actor });
  return { order: await getOrder(id) };
}

r.post('/orders/:id/fix-address', async (req, res) => {
  const out = await fixAddress(Number(req.params.id), req.body?.ship_to, 'client');
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(await withTimeline(out.order));
});

// ---------- Ops console ----------

r.post('/orders/:id/notify', async (req, res) => {
  const row = await getOrder(Number(req.params.id));
  if (!row?.demo) return res.status(404).json({ error: 'No such demo order' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required', field: 'message' });
  res.status(201).json(await appendEvent(row.id, 'cs_rep', 'client_notified', { message, source: 'cs_rep', channel: 'Portal inbox + SMS (demo)' }));
});

// Demo buttons standing in for the carrier's own feed.
r.post('/sim/carrier-event', async (req, res) => {
  const { order_id: id, type } = req.body || {};
  if (!SIM_EVENTS.includes(type)) return res.status(400).json({ error: `type must be one of ${SIM_EVENTS.join(', ')}`, field: 'type' });
  const { thread, distances } = await getThread();
  const o = threadOrder(await getOrder(Number(id)), distances);
  if (!o?.demo) return res.status(404).json({ error: 'No such demo order' });
  if (o.status === 'held') return res.status(409).json({ error: 'A held order has not shipped' });
  await thread.carrierEvent(o, type);
  res.json(await withTimeline(await getOrder(o.id)));
});

// Removes demo orders (their events cascade) and their parked approvals; the analysis data is never touched.
r.post('/demo/reset', async (_req, res) => {
  const [{ n }] = await q('WITH d AS (DELETE FROM inbound_orders WHERE demo RETURNING message_id) SELECT count(*)::int AS n FROM d');
  await q(`DELETE FROM inbound_messages m WHERE m.source = $1 AND m.channel = 'API' AND NOT EXISTS (SELECT 1 FROM inbound_orders o WHERE o.message_id = m.id)`, [DEMO_CLIENT]);
  await q(`DELETE FROM agent_decisions WHERE run_id = 'thread'`);
  res.json({ removed_orders: n });
});

// ---------- Public tracking (no site password; the token is the key) ----------

r.get('/track/:token', async (req, res) => {
  const row = await getOrderByToken(req.params.token);
  if (!row?.demo) return res.status(404).json({ error: 'No such tracking link' });
  res.json(publicView({ ...row, ref: ref(row.id) }, await timeline(row.id)));
});

r.post('/track/:token/fix-address', async (req, res) => {
  const row = await getOrderByToken(req.params.token);
  if (!row?.demo) return res.status(404).json({ error: 'No such tracking link' });
  const out = await fixAddress(row.id, req.body?.ship_to, 'recipient');
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(publicView({ ...out.order, ref: ref(row.id) }, await timeline(row.id)));
});

r.post('/track/:token/rate', async (req, res) => {
  const row = await getOrderByToken(req.params.token);
  if (!row?.demo) return res.status(404).json({ error: 'No such tracking link' });
  await appendEvent(row.id, 'recipient', 'rated', { up: Boolean(req.body?.up) });
  res.json(publicView({ ...row, ref: ref(row.id) }, await timeline(row.id)));
});

export default r;
