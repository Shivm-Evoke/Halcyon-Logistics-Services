// The golden thread: one gateway order run through the agents' own decision rules, step by step, with every step
// written to the order's event log. The client portal, the ops console and the public tracking page all read that log.
// Decisions come from the same pure functions the six-month replay uses; only the carrier's delay and delivery are
// simulated (demo buttons). Nothing here touches the analysis tables or the shared live day.
import { planWaves } from '../agents/wave.js';
import { allocateCarriers } from '../agents/carrier.js';
import { needsClientNotice } from '../agents/watchtower.js';

// The agents work on the shape of a historical delivery; a gateway order is mapped onto it.
const toAgentOrder = (o) => ({
  delivery_id: o.ref, received_ts: o.received_ts, commitment_type: o.commitment_type, fulfilment_warehouse_id: o.warehouse_id,
  sla: o.sla ? 1 : 0, account_tier: o.account_tier, account_status: o.account_status, carrier_id: o.carrier_id,
  distance_miles: o.distance_miles, cutoff_breach: 0, address_incomplete: 0, stock_miss: 0,
});

const delayTemplate = (o) => `Order ${o.ref}: our carrier reports it is running about a day late. We have flagged it and are watching it; `
  + 'you will get an update as soon as it is delivered. No action is needed from you.';

/**
 * @param store   { append(orderId, actor, type, detail), requestApproval(order, step, detail), notify(order, message, actor),
 *                  setCarrier(orderId, carrierId), getOrder(orderId) }
 * @param world   { model: { pOnTime(order) }, limits: { carrier_id: max orders today }, rates: { carrier_id: average rate } }
 * @param claude  optional { writeNotice(context, fallback) -> { text, source } }
 */
export function createThread({ store, world, settings, claude = null }) {
  async function draft(o) {
    const fallback = delayTemplate(o);
    if (!claude?.writeNotice) return { text: fallback, source: 'rules only' };
    return claude.writeNotice({ order: o.ref, client: o.client_id, event: 'carrier reported a delay of about one day', promised_date: o.promised_date }, fallback);
  }

  async function tellClient(o, notice, actor) {
    await store.notify(o, notice.text, actor);
    await store.append(o.id, actor, 'client_notified', { message: notice.text, source: notice.source, channel: 'Portal inbox + SMS (demo)' });
  }

  return {
    /** A released order: second wave or not, then a carrier, then the recipient's tracking link. */
    async release(o) {
      const agentOrder = toAgentOrder(o);
      const wave = planWaves([agentOrder], settings).get(o.ref);
      await store.append(o.id, 'wave_planner', 'wave_assigned', { wave: wave.wave, rule: wave.rule, warehouse_id: o.warehouse_id });
      const { assignments } = allocateCarriers([agentOrder], { model: world.model, limits: world.limits, rates: world.rates, settings, isFriday: false });
      const pick = assignments.get(o.ref);
      const carrierId = pick.needsApproval && pick.fallbackCarrierId ? pick.fallbackCarrierId : pick.carrier_id;
      await store.setCarrier(o.id, carrierId);
      o.carrier_id = carrierId;
      await store.append(o.id, 'carrier_agent', 'carrier_selected', { carrier_id: carrierId, rule: pick.rule, extra_cost_usd: Number(pick.extraCost.toFixed(2)) });
      await store.append(o.id, 'system', 'tracking_sent', { channel: 'SMS (demo)', url: `/track/${o.tracking_token}` });
      return { wave: wave.wave, carrier_id: carrierId };
    },

    /** Simulated carrier event. A delay goes through the Watchtower's rule: key clients' notices need approval. */
    async carrierEvent(o, type) {
      if (type === 'shipped' || type === 'delivered') {
        await store.append(o.id, 'carrier', type, type === 'delivered' ? { late: Boolean(o.delayed) } : {});
        return;
      }
      if (type !== 'delayed') throw new Error(`Unknown carrier event ${type}`);
      await store.append(o.id, 'carrier', 'delayed', { days: 1 });
      await store.append(o.id, 'watchtower', 'risk_flagged', { reason: 'Carrier reported a delay of about one day' });
      const notice = await draft(o);
      if (needsClientNotice(o)) {
        const row = await store.requestApproval(o, 'client_notice', { message: notice.text, source: notice.source });
        await store.append(o.id, 'watchtower', 'approval_requested', { decision_id: row.id, message: notice.text, source: notice.source,
          rule: 'Notifying a Tier 1 or at-risk client needs a manager\'s approval' });
      } else {
        await tellClient(o, notice, 'watchtower');
      }
    },

    /** A supervisor decided on a parked step. */
    async resume(decision) {
      const o = await store.getOrder(decision.decision.order_id);
      if (!o) return;
      if (decision.approval === 'approved') {
        await store.append(o.id, decision.actor || 'supervisor', 'approved', { decision_id: decision.id });
        await tellClient(o, { text: decision.decision.message, source: decision.decision.source }, 'cs_rep');
      } else {
        await store.append(o.id, decision.actor || 'supervisor', 'rejected', { decision_id: decision.id });
      }
    },
  };
}

// ---------- What the recipient may see ----------

const PUBLIC_LABELS = {
  received: 'Order received', held: 'Waiting for a correct address', client_fixed: 'Address corrected', released: 'Order confirmed',
  wave_assigned: 'Being picked at the warehouse', carrier_selected: 'Carrier booked', tracking_sent: 'Tracking link sent',
  shipped: 'On the way', delayed: 'Running about a day late', client_notified: 'We sent you an update', delivered: 'Delivered', rated: 'Thanks for your rating',
};
const STAGES = ['received', 'confirmed', 'on_the_way', 'delivered'];

/** Status, a delay banner and a timeline with plain labels; no internal actors, rules, costs or approval drafts. */
export function publicView(order, events) {
  const types = new Set(events.map((e) => e.type));
  const stage = types.has('delivered') ? 'delivered'
    : types.has('shipped') || types.has('delayed') || types.has('carrier_selected') ? 'on_the_way'
      : types.has('released') || types.has('wave_assigned') ? 'confirmed' : 'received';
  const delayed = types.has('delayed') && !types.has('delivered');
  return {
    ref: order.ref, status: order.status, commitment_type: order.commitment_type, promised_date: order.promised_date, carrier_id: order.carrier_id,
    stage, stages: STAGES, held: order.status === 'held',
    banner: delayed ? 'Your delivery is running about a day late. We spotted it early and are on it.' : null,
    rated: types.has('rated'),
    events: events.filter((e) => PUBLIC_LABELS[e.type]).map((e) => ({ ts: e.ts, type: e.type, label: PUBLIC_LABELS[e.type] })),
  };
}
