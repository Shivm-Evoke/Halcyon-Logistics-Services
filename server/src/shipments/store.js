// Shipment stage events on gateway orders.
import { q, one } from '../db.js';
import { initialStage } from './stages.js';

export const ensureShipmentTable = () => q(`
  CREATE TABLE IF NOT EXISTS shipment_events (
    id        serial PRIMARY KEY,
    order_id  integer NOT NULL REFERENCES inbound_orders ON DELETE CASCADE,
    stage     text NOT NULL,
    at        timestamp NOT NULL DEFAULT now(),
    by        text NOT NULL DEFAULT 'system',
    note      text
  )`);

export const shipmentStore = {
  /** Records `next` only if the order is still at `from`, in one statement, so a double click moves it once. */
  advance: (orderId, from, next, by) => one(`
    INSERT INTO shipment_events (order_id, stage, by)
    SELECT $1, $3, $4 WHERE (SELECT stage FROM shipment_events WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 1) = $2
    RETURNING *`, [orderId, from, next, by]),
  addEvent: (orderId, stage, by = 'system', note = null) => one(
    'INSERT INTO shipment_events (order_id, stage, by, note) VALUES ($1, $2, $3, $4) RETURNING *', [orderId, stage, by, note]),
  eventsFor: (orderIds) => q('SELECT * FROM shipment_events WHERE order_id = ANY($1) ORDER BY at, id', [orderIds]),
  latestStage: async (orderId) => (await one('SELECT stage FROM shipment_events WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 1', [orderId]))?.stage ?? null,
  /** The gateway's verdict as a stage: recorded when it differs from the current one (a fixed hold becomes received). */
  async recordVerdict(order) {
    const stage = initialStage(order.status);
    const current = await this.latestStage(order.id);
    // Only a new order, a hold or a just-received order takes the gateway's verdict; past that the shipment is moving.
    if (current === stage || (current && current !== 'on_hold' && current !== 'received')) return null;
    return this.addEvent(order.id, stage);
  },
};
