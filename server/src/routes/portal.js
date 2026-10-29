// Customer portal: a signed-in customer's account summary, new orders and shipments. Everything is scoped to
// the session's client; another client's order reads as not found.
import { Router } from 'express';
import { q, one, DEMO_NOW } from '../db.js';
import { getContainer } from '../container.js';
import { asShipments, idFromRef } from '../shipments/views.js';
import { shipmentStore } from '../shipments/store.js';
import { customerCanEdit, initialStage } from '../shipments/stages.js';

const r = Router();

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
  if (o) res.json((await asShipments([o], { withEvents: true }))[0]);
});

// One order from the portal form, through the same gateway pipeline as API, email and EDI orders.
r.post('/portal/orders', async (req, res) => {
  const b = req.body || {};
  const order = {
    client_order_ref: b.client_order_ref || undefined, sku: b.sku, quantity: b.quantity, service: b.service,
    requested_date: b.requested_date || undefined, ship_to: b.ship_to || {},
  };
  const { ingest, ingestRepo } = await getContainer();
  const result = await ingest.api(req.user.client_id, [order]);
  const ref = result.orders[0]?.ref;
  const row = ref && await ingestRepo.getOrder(idFromRef(ref));
  res.status(201).json(row ? (await asShipments([row], { withEvents: true }))[0] : result.orders[0]);
});

// Fix a held order; it is re-checked and released when clean.
r.patch('/portal/orders/:ref', async (req, res) => {
  const o = await own(req, res);
  if (!o) return;
  const stage = (await shipmentStore.latestStage(o.id)) ?? initialStage(o.status);
  if (!customerCanEdit(stage)) return res.status(409).json({ error: `This order is already ${stage.replace('_', ' ')} and can't be changed` });
  const { ingest, ingestRepo } = await getContainer();
  await ingest.reprocess(o.id, req.body || {});
  res.json((await asShipments([await ingestRepo.getOrder(o.id)], { withEvents: true }))[0]);
});

export default r;
