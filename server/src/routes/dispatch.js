// Dispatch board for Halcyon staff: open gateway orders by stage, moved on one stage at a time.
import { Router } from 'express';
import { q } from '../db.js';
import { getContainer } from '../container.js';
import { shipmentStore } from '../shipments/store.js';
import { STAGES, nextStage } from '../shipments/stages.js';
import { asShipments, idFromRef } from '../shipments/views.js';

const r = Router();

r.get('/dispatch', async (_req, res) => {
  const rows = await q(`SELECT o.*, c.client_name FROM inbound_orders o LEFT JOIN clients c USING (client_id)
                        ORDER BY o.id DESC LIMIT 500`);
  const names = new Map(rows.map((x) => [x.id, x.client_name]));
  const board = Object.fromEntries(['on_hold', ...STAGES.slice(0, -1)].map((s) => [s, []]));
  for (const s of await asShipments(rows)) {
    if (s.stage in board) board[s.stage].push({ ...s, client_name: names.get(idFromRef(s.ref)) ?? s.client_id });
  }
  res.json(board);
});

r.post('/dispatch/:ref/advance', async (req, res) => {
  const { ingestRepo } = await getContainer();
  const o = await ingestRepo.getOrder(idFromRef(req.params.ref));
  if (!o) return res.status(404).json({ error: 'not_found' });
  const current = await shipmentStore.latestStage(o.id);
  const next = nextStage(current);
  if (!next) return res.status(409).json({ error: `This order can't move on from ${String(current).replace('_', ' ')}` });
  const moved = await shipmentStore.advance(o.id, current, next, req.user?.email ?? 'staff');
  if (!moved) return res.status(409).json({ error: 'Someone else just moved this order; refresh the board' });
  res.json({ ref: req.params.ref, stage: next });
});

export default r;
