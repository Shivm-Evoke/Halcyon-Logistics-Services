// Wiring for the golden thread: the database-backed event store, the agents' measured world, and Claude.
import { q } from '../db.js';
import { getContainer } from '../container.js';
import { world } from '../routes/agents.js';
import { buildWorld, dayOf } from '../agents/simulator.js';
import { DEFAULT_SETTINGS } from '../agents/settings.js';
import { decisionLog } from '../agents/log.js';
import { createThread } from './thread.js';
import { appendEvent, getOrder, threadOrder } from './events.js';

const nowText = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

let threadPromise;
/** One thread runner per process, built once from the six months of history the agents measure on. */
export const getThread = () => (threadPromise ??= (async () => {
  const [w, { claude }] = await Promise.all([world(), getContainer()]);
  const { model, capacity } = buildWorld(w.orders, DEFAULT_SETTINGS);
  const days = new Set(w.orders.map(dayOf)).size;
  const limits = capacity.forDay(Math.round(w.orders.length / days)).limits;
  const store = {
    append: appendEvent,
    getOrder: async (id) => threadOrder(await getOrder(id), w.distances),
    setCarrier: (id, carrierId) => q('UPDATE inbound_orders SET carrier_id = $2, updated_at = now() WHERE id = $1', [id, carrierId]),
    notify: (o, message, actor) => q(`INSERT INTO notifications (delivery_id, client_id, channel, message, created_by) VALUES (NULL, $1, 'Portal + SMS (demo)', $2, $3)`,
      [o.client_id, `${o.ref}: ${message}`, actor]),
    async requestApproval(o, step, detail) {
      const [row] = await decisionLog.insert([{
        run_id: 'thread', sim_ts: nowText(), agent: 'watchtower', delivery_id: o.ref, decision: { order_id: o.id, step, ...detail },
        rule: 'Notifying a Tier 1 or at-risk client needs a manager\'s approval', reason: detail.message,
        reason_source: detail.source === 'claude' ? 'claude' : 'rules only', approval: 'pending',
      }]);
      return row;
    },
  };
  return { thread: createThread({ store, world: { model, limits, rates: w.rates }, settings: DEFAULT_SETTINGS, claude }), distances: w.distances, claude };
})().catch((e) => { threadPromise = undefined; throw e; }));
