// Data access for the inbound gateway.
import { q, one } from '../db.js';
import { shipmentStore } from '../shipments/store.js';

// Every saved or re-checked order gets its shipment stage from the gateway's verdict.
const recorded = async (row) => { if (row) await shipmentStore.recordVerdict(row); return row; };

export const ingestRepository = {
  loadClients: async () => new Map((await q('SELECT * FROM clients')).map((c) => [c.client_id, c])),

  createMessage: ({ channel, source, subject, raw }) => one(
    'INSERT INTO inbound_messages (channel, source, subject, raw) VALUES ($1, $2, $3, $4) RETURNING *',
    [channel, source, subject, raw?.slice(0, 200000)]),

  finishMessage: (id, { status, summary, reply }) => one(
    'UPDATE inbound_messages SET status = $2, summary = $3, reply = $4 WHERE id = $1 RETURNING *',
    [id, status, summary, reply]),

  saveOrder: async (o) => recorded(await one(`
    INSERT INTO inbound_orders (message_id, source_ref, client_id, client_order_ref, status, normalized, corrections, issues,
      risk, drivers, commitment_type, promised_date, warehouse_id, carrier_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [o.message_id, o.source_ref, o.client_id, o.client_order_ref, o.status, o.normalized, JSON.stringify(o.corrections),
    JSON.stringify(o.issues), o.risk, JSON.stringify(o.drivers), o.commitment_type, o.promised_date, o.warehouse_id, o.carrier_id])),

  updateOrder: async (id, o) => recorded(await one(`
    UPDATE inbound_orders SET status = $2, normalized = $3, corrections = $4, issues = $5, risk = $6, drivers = $7,
      commitment_type = $8, promised_date = $9, warehouse_id = $10, carrier_id = $11, updated_at = now()
    WHERE id = $1 RETURNING *`,
  [id, o.status, o.normalized, JSON.stringify(o.corrections), JSON.stringify(o.issues), o.risk, JSON.stringify(o.drivers),
    o.commitment_type, o.promised_date, o.warehouse_id, o.carrier_id])),

  getOrder: (id) => one('SELECT * FROM inbound_orders WHERE id = $1', [id]),

  // The same client sending the same PO again (anything not rejected counts).
  findLiveOrder: (clientId, ref) => one(
    `SELECT id, status FROM inbound_orders WHERE client_id = $1 AND client_order_ref = $2 AND status NOT IN ('rejected', 'duplicate')
     ORDER BY id LIMIT 1`, [clientId, ref]),

  otherClientsUsingRef: async (ref, clientId) => (await q(`
    SELECT DISTINCT client_id FROM (
      SELECT client_id FROM deliveries WHERE order_id = $1
      UNION ALL SELECT client_id FROM inbound_orders WHERE client_order_ref = $1 AND status <> 'rejected') t
    WHERE client_id <> $2`, [ref, clientId])).map((r) => r.client_id),

  // Orders already given to each carrier for a pick-list day.
  carrierUsage: async (day) => Object.fromEntries((await q(`
    SELECT carrier_id, count(*) AS n FROM inbound_orders
    WHERE status IN ('accepted', 'corrected') AND (normalized->>'pick_list_date') = $1 GROUP BY 1`, [day]))
    .map((r) => [r.carrier_id, r.n])),

  getApiClient: (id) => one('SELECT * FROM api_clients WHERE client_id = $1', [id]),
  // A client's new API secret (hashed) replaces any earlier one, which stops working at once.
  setApiSecret: (id, secretHash) => q(`INSERT INTO api_clients (client_id, secret_hash) VALUES ($1, $2)
    ON CONFLICT (client_id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, created_at = now(), last_login_at = NULL`, [id, secretHash]),
  touchLogin: (id) => q('UPDATE api_clients SET last_login_at = now() WHERE client_id = $1', [id]),
  getIdempotent: (clientId, key) => one('SELECT response FROM api_idempotency WHERE client_id = $1 AND key = $2', [clientId, key]),
  saveIdempotent: (clientId, key, response) => q(
    'INSERT INTO api_idempotency (client_id, key, response) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [clientId, key, response]),

  listMessages: () => q(`SELECT id, channel, source, subject, received_at, status, summary FROM inbound_messages ORDER BY id DESC LIMIT 200`),
  getMessage: async (id) => {
    const message = await one('SELECT * FROM inbound_messages WHERE id = $1', [id]);
    if (!message) return null;
    return { ...message, orders: await q('SELECT * FROM inbound_orders WHERE message_id = $1 ORDER BY id', [id]) };
  },
  clientOrders: (clientId) => q('SELECT * FROM inbound_orders WHERE client_id = $1 ORDER BY id DESC LIMIT 200', [clientId]),
  stats: async () => ({
    by_channel: await q(`
      SELECT m.channel, count(DISTINCT m.id) AS messages, count(o.id) AS orders,
             count(o.id) FILTER (WHERE o.status = 'accepted') AS accepted,
             count(o.id) FILTER (WHERE o.status = 'corrected') AS corrected,
             count(o.id) FILTER (WHERE o.status = 'held') AS held,
             count(o.id) FILTER (WHERE o.status IN ('rejected', 'duplicate')) AS rejected
      FROM inbound_messages m LEFT JOIN inbound_orders o ON o.message_id = m.id GROUP BY 1 ORDER BY 1`),
    by_issue: await q(`
      SELECT i->>'code' AS code, i->>'severity' AS severity, count(*) AS n
      FROM inbound_orders o, jsonb_array_elements(o.issues) i GROUP BY 1, 2 ORDER BY 3 DESC`),
    by_correction: await q(`
      SELECT c->>'rule' AS rule, count(*) AS n FROM inbound_orders o, jsonb_array_elements(o.corrections) c
      WHERE c->>'rule' <> 'formatting' GROUP BY 1 ORDER BY 2 DESC`),
  }),
};
