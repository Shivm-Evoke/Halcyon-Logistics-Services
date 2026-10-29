// Customer portal: a signed-in customer's account summary, new orders (form, EDI, email, samples), API key and
// shipments. Everything is scoped to the session's client; another client's order reads as not found.
import express, { Router } from 'express';
import { q, one, DEMO_NOW } from '../db.js';
import { getContainer } from '../container.js';
import { asShipments, idFromRef } from '../shipments/views.js';
import { shipmentStore } from '../shipments/store.js';
import { customerCanEdit, initialStage } from '../shipments/stages.js';
import { getDesk, refreshDesk, deskClock } from '../desk/instance.js';
import { deskRepo } from '../desk/repository.js';
import { forceFor, formOrder, sendSample, rotateApiKey, customerDecisions } from '../portal/channels.js';

const r = Router();
const rawBody = express.text({ type: ['message/rfc822', 'text/plain', 'application/edi-x12'], limit: '5mb' });
const content = (req) => (typeof req.body === 'string' ? req.body : req.body?.content || '');
// Portal orders are the session's client's, received at the ops clock.
const force = async (req) => forceFor(req.user, await deskClock());

// The gateway's results as shipments (an order it did not store stays as the gateway reported it).
async function shipmentsOf(results) {
  const { ingestRepo } = await getContainer();
  return Promise.all(results.map(async (o) => {
    const row = o.ref && await ingestRepo.getOrder(idFromRef(o.ref));
    return row ? (await asShipments([row], { withEvents: true }))[0] : o;
  }));
}

// What the agents did to an order in the desk's current run, in the customer's words; an order outside the run,
// or a desk that is off or failing, has none.
async function decisionsFor(shipment, gatewayCarrierId) {
  try {
    const state = await (await getDesk()).state();
    const order = state.orders.find((o) => o.ref === shipment.ref);
    if (!order) return [];
    const rows = (await deskRepo.decisions(state.clock.runId)).filter((d) => d.delivery_id === shipment.ref);
    return customerDecisions(rows, order, shipment.events, gatewayCarrierId ?? undefined);
  } catch (e) {
    console.error('Portal decisions failed:', e.message);
    return [];
  }
}

r.get('/portal/summary', async (req, res) => {
  const id = req.user.client_id;
  const [client, history, open] = await Promise.all([
    one('SELECT client_id, client_name, account_tier, region FROM clients WHERE client_id = $1', [id]),
    one(`SELECT count(*)::int AS orders, avg((on_time = 'Y')::int)::float AS on_time, min(order_received_ts)::date AS since
         FROM deliveries WHERE client_id = $1 AND order_received_ts > $2::timestamp - interval '90 days' AND order_received_ts <= $2::timestamp`, [id, DEMO_NOW]),
    q('SELECT * FROM inbound_orders WHERE client_id = $1 ORDER BY id DESC LIMIT 200', [id]),
  ]);
  const byStage = {};
  for (const s of await asShipments(open)) byStage[s.stage ?? 'received'] = (byStage[s.stage ?? 'received'] || 0) + 1;
  res.json({ client, history, byStage });
});

r.get('/portal/orders', async (req, res) => {
  const { ingestRepo } = await getContainer();
  res.json(await asShipments(await ingestRepo.clientOrders(req.user.client_id)));
});

async function own(req, res) {
  const { ingestRepo } = await getContainer();
  const o = await ingestRepo.getOrder(idFromRef(req.params.ref));
  if (!o || o.client_id !== req.user.client_id) { res.status(404).json({ error: 'not_found', message: `No shipment ${req.params.ref}` }); return null; }
  return o;
}

r.get('/portal/orders/:ref', async (req, res) => {
  const o = await own(req, res);
  if (!o) return;
  const [shipment] = await asShipments([o], { withEvents: true });
  res.json({ ...shipment, decisions: await decisionsFor(shipment, o.normalized?.gateway_carrier_id) });
});

// One order from the portal form, through the same gateway pipeline as API, email and EDI orders.
r.post('/portal/orders', async (req, res) => {
  const { ingest } = await getContainer();
  const result = await ingest.form(req.user.client_id, formOrder(req.body || {}), await force(req));
  await refreshDesk();
  res.status(201).json((await shipmentsOf(result.orders))[0]);
});

// An X12 850 file or a raw email (.eml), as text or { content }. The client is the session's, whatever the file says.
r.post('/portal/edi', rawBody, async (req, res) => {
  if (!content(req).trim()) return res.status(400).json({ error: 'Empty EDI file' });
  const result = await (await getContainer()).ingest.edi(content(req), { filename: req.body?.filename }, await force(req));
  await refreshDesk();
  res.status(201).json({ orders: await shipmentsOf(result.orders) });
});

r.post('/portal/email', rawBody, async (req, res) => {
  if (!content(req).trim()) return res.status(400).json({ error: 'Empty email' });
  const result = await (await getContainer()).ingest.email(content(req), { filename: req.body?.filename }, await force(req));
  await refreshDesk();
  res.status(201).json({ orders: await shipmentsOf(result.orders) });
});

// One of the five sample orders (1-5), each showing one cause of late deliveries, sent through its own channel.
r.post('/portal/samples/:n', async (req, res) => {
  const sent = await sendSample((await getContainer()).ingest, req.params.n, await force(req));
  if (!sent) return res.status(404).json({ error: 'not_found', message: `No sample ${req.params.n}; samples are 1 to 5` });
  await refreshDesk();
  res.status(201).json({ channel: sent.channel, orders: await shipmentsOf(sent.result.orders) });
});

// A new API key for the client: the secret is shown once, and the previous one stops working.
r.post('/portal/api-key', async (req, res) => {
  const { ingestRepo } = await getContainer();
  res.status(201).set('Cache-Control', 'no-store').json(await rotateApiKey(ingestRepo, req.user.client_id));
});

// Fix a held order; it is re-checked and released when clean.
r.patch('/portal/orders/:ref', async (req, res) => {
  const o = await own(req, res);
  if (!o) return;
  const stage = (await shipmentStore.latestStage(o.id)) ?? initialStage(o.status);
  if (!customerCanEdit(stage)) return res.status(409).json({ error: `This order is already ${stage.replace('_', ' ')} and can't be changed` });
  const { ingest, ingestRepo } = await getContainer();
  await ingest.reprocess(o.id, req.body || {});
  await refreshDesk();
  res.json((await asShipments([await ingestRepo.getOrder(o.id)], { withEvents: true }))[0]);
});

export default r;
