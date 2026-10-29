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

/**
 * An event's time: `at` (the desk's ops clock, 'YYYY-MM-DD HH:MM') or the database's now() without one, never
 * before the order's latest event, so the stage order (by time, then id) holds even if the two clocks meet.
 * @param atParam    the placeholder of `at`, e.g. '$5'
 * @param orderParam the placeholder of the order id
 */
export const eventTime = (atParam, orderParam = '$1') =>
  `GREATEST(COALESCE(${atParam}::timestamp, now()::timestamp), (SELECT max(at) FROM shipment_events WHERE order_id = ${orderParam}))`;

/** @param db { q, one } */
export function createShipmentStore({ q: query, one: first }) {
  return {
    /** Records `next` only if the order is still at `from`, in one statement, so a double click moves it once. `at`: ops clock or null (now). */
    advance: (orderId, from, next, by, at = null) => first(`
      INSERT INTO shipment_events (order_id, stage, by, at)
      SELECT $1, $3, $4, ${eventTime('$5')} WHERE (SELECT stage FROM shipment_events WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 1) = $2
      RETURNING *`, [orderId, from, next, by, at]),
    addEvent: (orderId, stage, by = 'system', note = null, at = null) => first(`
      INSERT INTO shipment_events (order_id, stage, by, note, at) VALUES ($1, $2, $3, $4, ${eventTime('$5')}) RETURNING *`,
    [orderId, stage, by, note, at]),
    eventsFor: (orderIds) => query('SELECT * FROM shipment_events WHERE order_id = ANY($1) ORDER BY at, id', [orderIds]),
    latestStage: async (orderId) => (await first('SELECT stage FROM shipment_events WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 1', [orderId]))?.stage ?? null,
    /** The gateway's verdict as a stage: recorded when it differs from the current one (a fixed hold becomes received). */
    async recordVerdict(order, at = null) {
      const stage = initialStage(order.status);
      const current = await this.latestStage(order.id);
      // Only a new order, a hold or a just-received order takes the gateway's verdict; past that the shipment is moving.
      if (current === stage || (current && current !== 'on_hold' && current !== 'received')) return null;
      return this.addEvent(order.id, stage, 'system', null, at);
    },
  };
}

export const shipmentStore = createShipmentStore({ q, one });
