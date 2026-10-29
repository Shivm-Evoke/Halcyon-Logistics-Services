// The customer portal's order channels: EDI, email, the portal form and the five sample orders (one per cause of
// late deliveries), all sent through the gateway as the signed-in customer's client at the desk's ops clock;
// the customer's own API key; and the agents' decisions on an order as the customer sees them.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashSecret } from '../ingest/auth.js';
import { effectsOf } from '../desk/effects.js';

export const SAMPLES_DIR = path.resolve(import.meta.dirname, '../../data/samples');

/** The five samples: 1 incomplete address, 2 same-day after the cutoff, 3 stock miss, 4 Tier 1 / same-day carrier, 5 late risk. */
export const SAMPLES = Object.freeze({
  1: { file: '1-email.eml', channel: 'Email' },
  2: { file: '2-edi.x12', channel: 'EDI' },
  3: { file: '3-api.json', channel: 'API' },
  4: { file: '4-form.json', channel: 'Portal form' },
  5: { file: '5-api.json', channel: 'API' },
});

/** Portal orders belong to the session's client and arrive at the ops clock (or the gateway's own time without one). */
export const forceFor = (user, clockNow) => ({ client_id: user.client_id, received_ts: clockNow ?? undefined });

/** The portal form's fields as one gateway order. */
export const formOrder = (b = {}) => ({
  client_order_ref: b.client_order_ref || undefined, sku: b.sku, quantity: b.quantity, service: b.service,
  requested_date: b.requested_date || undefined, ship_to: b.ship_to || {},
});

/** A sample's PO numbers (SAMPLE-n) get a unique suffix, so a sample can be sent again without being a duplicate. */
export const freshPo = (text, suffix) => text.replace(/\bSAMPLE-(\d)\b/g, `SAMPLE-$1-${suffix}`);

/**
 * Sends sample `n` through its channel, exactly as a customer would.
 * @returns null for an unknown sample; else { channel, result } with the gateway's result
 */
export async function sendSample(ingest, n, force, { dir = SAMPLES_DIR, suffix = Date.now().toString(36).toUpperCase() } = {}) {
  const sample = Object.hasOwn(SAMPLES, n) ? SAMPLES[n] : null;
  if (!sample) return null;
  const raw = freshPo(await fs.readFile(path.join(dir, sample.file), 'utf8'), suffix);
  const opts = { filename: sample.file };
  const result = sample.channel === 'Email' ? await ingest.email(raw, opts, force)
    : sample.channel === 'EDI' ? await ingest.edi(raw, opts, force)
      : sample.channel === 'Portal form' ? await ingest.form(force.client_id, formOrder(JSON.parse(raw)), force)
        : await ingest.api(force.client_id, JSON.parse(raw).orders, force);
  return { channel: sample.channel, result };
}

/**
 * A new API secret for the client, replacing any earlier one. The secret is returned once and stored only as a hash.
 * @param store { setApiSecret(clientId, secretHash) }
 */
export async function rotateApiKey(store, clientId) {
  const secret = crypto.randomBytes(24).toString('base64url');
  await store.setApiSecret(clientId, hashSecret(secret));
  return { client_id: clientId, secret, token_url: '/api/auth/login', docs_url: '/api/docs' };
}

/**
 * The agents' decisions on one desk order, as the customer sees them: the effect note the desk wrote on the shipment
 * (effectsOf's customer sentence), never Claude's or the rule's staff-facing text, which carry costs and approvals.
 * A decision with no effect, or whose note the desk has not written, is left out.
 * @param rows      agent_decisions rows for the order (agent, decision, approval, sim_ts)
 * @param deskOrder the order in the desk's state (received_ts, commitment_type, warehouse_id, carrier_id, client.account_tier)
 * @param events    the shipment's events ({ by, note })
 * @param gatewayCarrierId the carrier the gateway chose (normalized.gateway_carrier_id); older orders fall back to the row's
 */
export function customerDecisions(rows, deskOrder, events = [], gatewayCarrierId = deskOrder?.carrier_id) {
  if (!deskOrder) return [];
  const written = new Set(events.filter((e) => e.by === 'agents' && e.note).map((e) => e.note));
  const order = {
    received_ts: deskOrder.received_ts, commitment_type: deskOrder.commitment_type, account_tier: deskOrder.client?.account_tier,
    nearest_warehouse_id: deskOrder.warehouse_id, gateway_carrier_id: gatewayCarrierId ?? null,
  };
  return rows.flatMap((r) => {
    const note = effectsOf(r.decision, order, r.approval)?.note;
    return note && written.has(note) ? [{ agent: r.agent, text: note, at: r.sim_ts }] : [];
  });
}
