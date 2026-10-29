// Gateway orders as shipments: the order's own fields plus its stage, timeline and risk flag.
import { apiOrderResult } from '../ingest/reply.js';
import { shipmentStore } from './store.js';
import { stageOf, atRisk, initialStage } from './stages.js';

export const orderRef = (id) => `IN-${String(id).padStart(6, '0')}`;
// An unrecognised ref is id 0, which matches nothing (a not found, not a database error).
export const idFromRef = (s) => Number(/^IN-(\d{1,9})$/i.exec(String(s))?.[1] ?? 0);

/** rows: inbound_orders rows → shipments with stage, atRisk, ship_to, sku, quantity (and events when asked). */
export async function asShipments(rows, { withEvents = false } = {}) {
  const events = rows.length ? await shipmentStore.eventsFor(rows.map((r) => r.id)) : [];
  return rows.map((r) => {
    const own = events.filter((e) => e.order_id === r.id);
    const risk = r.risk == null ? null : Number(r.risk);
    return {
      ...apiOrderResult({ ...r, ref: orderRef(r.id), risk }),
      client_id: r.client_id,
      sku: r.normalized?.sku ?? null,
      quantity: r.normalized?.quantity ?? null,
      ship_to: r.normalized?.ship_to ?? null,
      created_at: r.created_at,
      stage: stageOf(own) ?? initialStage(r.status), // orders from before stages were recorded
      atRisk: atRisk(risk),
      ...(withEvents ? { events: own.map(({ stage, at, by, note }) => ({ stage, at, by, note })) } : {}),
    };
  });
}
