// Live order desk API for staff: the desk's state, the ops clock and moving orders on.
import { Router } from 'express';
import { getDesk } from '../desk/instance.js';

const r = Router();
const TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** True for a real 'YYYY-MM-DD HH:MM' date-time. */
export function validClockTime(s) {
  const m = TS.exec(String(s ?? ''));
  if (!m) return false;
  const [, y, mo, d, h, mi] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h < 24 && mi < 60;
}

const off = (res) => res.status(409).json({ error: 'The live order desk is off (DESK=0)' });

r.get('/desk', async (_req, res) => res.json(await (await getDesk()).state()));

r.post('/desk/clock', async (req, res) => {
  const setTo = req.body?.set_to;
  if (!validClockTime(setTo)) return res.status(400).json({ error: "set_to must be a date and time like '2026-09-25 07:30'", field: 'set_to' });
  const desk = await getDesk();
  if (!desk.enabled) return off(res);
  res.json(await desk.setClock(setTo));
});

r.post('/desk/advance', async (_req, res) => {
  const desk = await getDesk();
  if (!desk.enabled) return off(res);
  res.json(await desk.advance());
});

r.post('/desk/orders/:ref/advance', async (req, res) => {
  const desk = await getDesk();
  if (!desk.enabled) return off(res);
  const result = await desk.advanceOrder(req.params.ref);
  if (!result) return res.status(404).json({ error: `No live order ${req.params.ref}` });
  if (!result.moved) return res.status(409).json({ error: `${req.params.ref} is ${result.stage.replace('_', ' ')} and can't move on`, state: result.state });
  res.json(result.state);
});

export default r;
