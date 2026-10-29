// Turns one agent decision into what it does to the order and the sentence the shipment note shows.
// approval: 'auto' (no approval needed) | 'pending' | 'approved' | 'rejected' | 'expired'.
import { promiseDelivery } from '../rules.js';

const taken = (approval) => approval === 'auto' || approval === 'approved';

/**
 * @param decision      an agent decision from deskDecide
 * @param decidedOrder  the order as the agents left it (carries nearest_warehouse_id, received_ts, gateway_carrier_id)
 * @returns {{ fields: { commitment_type?, promised_date?, carrier_id?, warehouse_id?, release?: true }, note: string } | null}
 */
export function effectsOf(decision, decidedOrder, approval) {
  switch (decision.agent) {
    case 'wave': {
      if (decision.needsApproval && approval === 'pending') return { fields: {}, note: 'Waiting for approval to join the second wave' };
      if (decision.needsApproval && !taken(approval)) {
        const { promisedDate } = promiseDelivery({ receivedTs: decidedOrder.received_ts, commitmentType: 'next_day' });
        return { fields: { commitment_type: 'next_day', promised_date: promisedDate }, note: 'Second wave full: promised next-day' };
      }
      return decision.wave === 2 || decision.needsApproval ? { fields: {}, note: 'Second pick wave at 13:00: still same-day' } : null;
    }
    case 'intake':
      if (!decision.fixAddress) return { fields: {}, note: 'Address query sent to the client' };
      return taken(approval) ? { fields: { release: true }, note: "Address completed from the client's records" } : null;
    case 'stock':
      return { fields: { warehouse_id: decidedOrder.nearest_warehouse_id }, note: `Stock moved to the nearest warehouse (${decidedOrder.nearest_warehouse_id})` };
    case 'carrier': {
      const x = decision.carrier_id;
      if (decision.needsApproval && approval === 'pending') return { fields: {}, note: `Carrier ${x} waiting for approval (over the cost limit)` };
      const chosen = decision.needsApproval && !taken(approval) ? decision.fallbackCarrierId : x;
      if (!chosen || chosen === decidedOrder.gateway_carrier_id) return null;
      return { fields: { carrier_id: chosen }, note: `Carrier ${chosen} chosen: more reliable on this lane` };
    }
    case 'watchtower': {
      const notes = [];
      const fields = {};
      if (decision.action === 'upgrade') {
        fields.carrier_id = decision.carrier_id;
        notes.push(`Moved to carrier ${decision.carrier_id} before the 14:00 collection`);
      }
      if (decision.notifyClient && taken(approval)) notes.push('Client told about the risk of a late delivery');
      return notes.length ? { fields, note: notes.join('. ') } : null;
    }
    default:
      return null;
  }
}
