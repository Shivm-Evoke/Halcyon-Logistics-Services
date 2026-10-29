// Maps an order the gateway has accepted (an inbound_orders row) to the shape the agents work on, and runs the
// agents over a day's live orders. Pure: the desk service supplies the rows, the clients and the context.
import { simulateDay } from '../agents/simulator.js';
import { validateAddress, PICK_LIST_CUTOFF } from '../rules.js';
import { orderRef } from '../shipments/views.js';

const isoTs = (ts) => String(ts ?? '').replace('T', ' ').slice(0, 16);

/**
 * @param row  inbound_orders row with `normalized` (and `channel`, joined from inbound_messages, when known)
 * @param ctx  { client: {client_name, account_tier, account_status}, distances, stockMiss(clientId, region), threshold }
 * @returns the order as the agents expect it
 */
export function toAgentOrder(row, { client = {}, distances = {}, stockMiss = () => 0, threshold = 0.1 } = {}) {
  const n = row.normalized || {};
  const region = validateAddress(n.ship_to).region ?? null;
  const warehouse = row.warehouse_id ?? null;
  const receivedTs = isoTs(n.received_ts);
  const commitment = n.commitment_type ?? row.commitment_type ?? 'standard';
  return {
    delivery_id: orderRef(row.id),
    order_id: row.id,
    client_id: row.client_id,
    client_name: client.client_name ?? null,
    account_tier: client.account_tier ?? null,
    account_status: client.account_status ?? null,
    commitment_type: commitment,
    received_ts: receivedTs,
    destination_region: region,
    nearest_warehouse_id: warehouse,
    fulfilment_warehouse_id: warehouse,
    distance_miles: warehouse && region ? (distances[warehouse]?.[region] ?? null) : null,
    address_incomplete: row.status === 'held' ? 1 : 0,
    stock_miss: region && stockMiss(row.client_id, region) >= threshold ? 1 : 0,
    carrier_id: row.carrier_id ?? null,
    gateway_carrier_id: row.carrier_id ?? null,
    cutoff_breach: commitment === 'same_day' && receivedTs.slice(11, 16) >= PICK_LIST_CUTOFF ? 1 : 0,
    order_channel: row.channel ?? n.order_channel ?? null,
  };
}

/**
 * Runs the agents over the day's live orders. Held orders get the intake agent only; the others get every
 * enabled agent, and only when they have a region and a warehouse to work from.
 * @returns {{ decided: object[], decisions: object[] }}
 */
export function deskDecide(agentOrders, ctx) {
  const held = agentOrders.filter((o) => o.address_incomplete);
  const live = agentOrders.filter((o) => !o.address_incomplete && o.destination_region && o.nearest_warehouse_id);
  const intakeOnly = { ...ctx, settings: { ...ctx.settings, agents: { intake: ctx.settings.agents.intake, wave: false, stock: false, carrier: false, watchtower: false } } };
  const a = simulateDay(held, intakeOnly);
  const b = simulateDay(live, ctx);
  return { decided: [...a.decided, ...b.decided], decisions: [...a.decisions, ...b.decisions] };
}
