// The agents' decision log: every decision with its rule, Claude's reason (or "rules only") and its approval state.
// Only a pending decision can be approved or rejected, so a repeated or late click never acts twice.
import { q } from '../db.js';

const DECIDABLE = new Set(['approved', 'rejected']);

/** Creates the decision table on a database loaded before the agents existed (e.g. an existing Azure database). */
export const ensureDecisionTable = () => q(`
  CREATE TABLE IF NOT EXISTS agent_decisions (
    id            serial PRIMARY KEY,
    run_id        text NOT NULL,
    sim_ts        text NOT NULL,
    agent         text NOT NULL,
    delivery_id   text,
    decision      jsonb NOT NULL DEFAULT '{}',
    rule          text,
    reason        text,
    reason_source text NOT NULL DEFAULT 'rules only' CHECK (reason_source IN ('claude', 'rules only')),
    approval      text NOT NULL CHECK (approval IN ('auto', 'pending', 'approved', 'rejected', 'expired')),
    actor         text,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agent_decisions_run ON agent_decisions (run_id, approval);`);

export const decisionLog = {
  async insert(rows) {
    if (!rows.length) return [];
    const cols = ['run_id', 'sim_ts', 'agent', 'delivery_id', 'decision', 'rule', 'reason', 'reason_source', 'approval'];
    const values = rows.flatMap((r) => cols.map((c) => (c === 'decision' ? JSON.stringify(r[c] ?? {}) : r[c] ?? null)));
    const tuples = rows.map((_, i) => `(${cols.map((__, j) => `$${i * cols.length + j + 1}`).join(', ')})`);
    return q(`INSERT INTO agent_decisions (${cols.join(', ')}) VALUES ${tuples.join(', ')} RETURNING *`, values);
  },

  list({ runId, agent, approval, limit = 500 } = {}) {
    return q(`SELECT * FROM agent_decisions
              WHERE ($1::text IS NULL OR run_id = $1) AND ($2::text IS NULL OR agent = $2) AND ($3::text IS NULL OR approval = $3)
              ORDER BY id DESC LIMIT $4`, [runId ?? null, agent ?? null, approval ?? null, limit]);
  },

  async setApproval(id, approval, actor) {
    if (!DECIDABLE.has(approval)) throw new Error(`approval must be approved or rejected, not ${approval}`);
    const [changed] = await q(`UPDATE agent_decisions SET approval = $2, actor = $3 WHERE id = $1 AND approval = 'pending' RETURNING *`, [id, approval, actor]);
    if (changed) return { changed: true, row: changed };
    const [row] = await q('SELECT * FROM agent_decisions WHERE id = $1', [id]);
    return { changed: false, row: row ?? null };
  },

  setReason(id, reason, source) {
    return q('UPDATE agent_decisions SET reason = $2, reason_source = $3 WHERE id = $1', [id, reason, source]);
  },

  expire(runId, ids) {
    return q(`UPDATE agent_decisions SET approval = 'expired' WHERE run_id = $1 AND id = ANY($2) AND approval = 'pending' RETURNING id`, [runId, ids]);
  },
};

/** Same interface in memory, for tests and for running without a database. */
export function createMemoryLog() {
  const rows = [];
  let next = 1;
  return {
    async insert(input) {
      const added = input.map((r) => ({ ...r, id: next++, actor: null, created_at: new Date().toISOString() }));
      rows.push(...added);
      return added.map((r) => ({ ...r }));
    },
    async list({ runId, agent, approval, limit = 500 } = {}) {
      return rows
        .filter((r) => (!runId || r.run_id === runId) && (!agent || r.agent === agent) && (!approval || r.approval === approval))
        .slice(-limit).reverse().map((r) => ({ ...r }));
    },
    async setApproval(id, approval, actor) {
      if (!DECIDABLE.has(approval)) throw new Error(`approval must be approved or rejected, not ${approval}`);
      const row = rows.find((r) => r.id === Number(id));
      if (!row) return { changed: false, row: null };
      if (row.approval !== 'pending') return { changed: false, row: { ...row } };
      Object.assign(row, { approval, actor });
      return { changed: true, row: { ...row } };
    },
    async setReason(id, reason, source) {
      const row = rows.find((r) => r.id === Number(id));
      if (row) Object.assign(row, { reason, reason_source: source });
    },
    async expire(runId, ids) {
      const hit = rows.filter((r) => r.run_id === runId && ids.includes(r.id) && r.approval === 'pending');
      for (const r of hit) r.approval = 'expired';
      return hit.map((r) => ({ id: r.id }));
    },
  };
}
