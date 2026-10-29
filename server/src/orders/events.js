// The shared order event log: one row per thing that happened to a gateway order, by whom. The client portal, the ops
// console and the public tracking page are views of it. Demo orders are flagged so a reset removes only them.
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { validateAddress } from '../rules.js';

/** Creates the log and the two order columns on a database loaded before they existed (e.g. the Azure database). */
export const ensureOrderEventsTable = () => q(`
  CREATE TABLE IF NOT EXISTS order_events (
    id        serial PRIMARY KEY,
    order_id  integer NOT NULL REFERENCES inbound_orders(id) ON DELETE CASCADE,
    ts        timestamp NOT NULL DEFAULT now(),
    actor     text NOT NULL,
    type      text NOT NULL,
    detail    jsonb NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS order_events_order_ts ON order_events (order_id, ts, id);
  ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS tracking_token text UNIQUE;
  ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;`);

export const newToken = () => crypto.randomBytes(8).toString('hex');

export const appendEvent = (orderId, actor, type, detail = {}) =>
  one('INSERT INTO order_events (order_id, actor, type, detail) VALUES ($1, $2, $3, $4) RETURNING *', [orderId, actor, type, JSON.stringify(detail)]);

export const timeline = (orderId) => q('SELECT * FROM order_events WHERE order_id = $1 ORDER BY ts, id', [orderId]);

export const ref = (id) => `IN-${String(id).padStart(6, '0')}`;

/** A gateway order with what the agents need about its client, in the shape the golden thread works on. */
const ORDER_SQL = `
  SELECT o.*, c.account_tier, c.account_status, (c.sla_penalty_clause = 'Y') AS sla, c.client_name,
         EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.type = 'delayed') AS delayed
  FROM inbound_orders o LEFT JOIN clients c USING (client_id)`;

export function threadOrder(row, distances = {}) {
  if (!row) return null;
  const n = row.normalized || {};
  return {
    ...row,
    ref: ref(row.id),
    received_ts: String(n.received_ts || '').replace('T', ' '),
    distance_miles: distances[row.warehouse_id]?.[validateAddress(n.ship_to || {}).region] ?? null,
  };
}

export const getOrder = (id) => one(`${ORDER_SQL} WHERE o.id = $1`, [id]);
export const getOrderByToken = (token) => one(`${ORDER_SQL} WHERE o.tracking_token = $1`, [token]);
export const listDemoOrders = (clientId) => q(`${ORDER_SQL} WHERE o.demo AND ($1::text IS NULL OR o.client_id = $1) ORDER BY o.id DESC LIMIT 50`, [clientId ?? null]);
