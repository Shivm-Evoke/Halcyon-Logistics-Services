// The live order desk's SQL: the ops clock, the day's live orders, stage notes and the agents' decisions.
import { q, one } from '../db.js';

const UPDATABLE = ['commitment_type', 'promised_date', 'carrier_id', 'warehouse_id', 'status'];

/** Creates the single-row ops clock table if missing. */
export const ensureDeskTable = () => q(`
  CREATE TABLE IF NOT EXISTS desk_clock (
    id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    set_to         timestamp NOT NULL,
    set_at         timestamptz NOT NULL,
    run_no         int NOT NULL,
    run_started_at timestamptz NOT NULL,
    run_from       timestamp
  );
  ALTER TABLE desk_clock ADD COLUMN IF NOT EXISTS run_from timestamp;`);

export const deskRepo = {
  getClock: () => one('SELECT * FROM desk_clock WHERE id = 1'),
  /** Starts a new run at `setTo`: run number up by one, run and clock start now; the run is named after `setTo`. */
  setClock: (setTo) => one(`
    INSERT INTO desk_clock (id, set_to, set_at, run_no, run_started_at, run_from) VALUES (1, $1, now(), 1, now(), $1)
    ON CONFLICT (id) DO UPDATE SET set_to = $1, set_at = now(), run_no = desk_clock.run_no + 1, run_started_at = now(), run_from = $1
    RETURNING *`, [setTo]),
  /** Moves the clock within the same run (its name stays). */
  shiftClock: (to) => one('UPDATE desk_clock SET set_to = $1, set_at = now() WHERE id = 1 RETURNING *', [to]),
  /**
   * Orders the gateway took in this run. created_at is a zone-less timestamp written by now() in the session's
   * zone, so it is read back as timestamptz in that same zone before comparing with run_started_at.
   */
  liveOrders: (runStartedAt) => q(`
    SELECT o.*, m.channel, c.client_name, c.account_tier, c.account_status
    FROM inbound_orders o
    JOIN inbound_messages m ON m.id = o.message_id
    LEFT JOIN clients c ON c.client_id = o.client_id
    WHERE o.status IN ('accepted', 'corrected', 'held') AND o.created_at::timestamptz >= $1
    ORDER BY o.id`, [runStartedAt]),
  /** Updates only the allow-listed columns; other keys are ignored. */
  async updateOrder(id, fields = {}) {
    const keys = UPDATABLE.filter((k) => k in fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = now()');
    return one(`UPDATE inbound_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => fields[k])]);
  },
  /** Adds a note event as the agents unless the order already has that note. */
  addNoteOnce: (orderId, stage, note) => one(`
    INSERT INTO shipment_events (order_id, stage, by, note)
    SELECT $1, $2, 'agents', $3
    WHERE NOT EXISTS (SELECT 1 FROM shipment_events WHERE order_id = $1 AND note = $3)
    RETURNING *`, [orderId, stage, note]),
  decisions: (runId) => q('SELECT * FROM agent_decisions WHERE run_id = $1 ORDER BY id', [runId]),
  /**
   * Updates a decision's content. With `reset` (the agents now choose differently), its approval starts again:
   * approval and sim_ts as given, no actor, and the reason back to the rule until Claude explains it again.
   */
  updateDecision: (id, { decision, rule, reset = null }) => one(`
    UPDATE agent_decisions SET decision = $2, rule = $3,
      approval = COALESCE($4, approval), sim_ts = COALESCE($5, sim_ts),
      actor = CASE WHEN $4::text IS NULL THEN actor END,
      reason = CASE WHEN $4::text IS NULL THEN reason ELSE $3 END,
      reason_source = CASE WHEN $4::text IS NULL THEN reason_source ELSE 'rules only' END
    WHERE id = $1 RETURNING *`, [id, JSON.stringify(decision), rule, reset?.approval ?? null, reset?.sim_ts ?? null]),
};
