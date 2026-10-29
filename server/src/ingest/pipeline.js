// The inbound pipeline every channel feeds into:
//   raw record -> normalise (auto-fix) -> duplicate checks -> validate -> AI layer -> decision -> store.
// Decisions: accepted (clean), corrected (accepted after auto-fixes), held (client must fix),
// rejected (cannot be processed), duplicate (already received).
import { normalizeOrder } from './normalize.js';
import { validateOrder } from './validate.js';
import { validateAddress, promiseDelivery } from '../rules.js';
import { orderFeatures } from '../ml/features.js';
import { RISK_THRESHOLD } from '../ml/ModelRegistry.js';

// Anomaly codes the validator already covers, so they are not reported twice.
const COVERED = new Set(['address_invalid', 'address_incomplete', 'impossible_promise', 'unknown_client', 'duplicate_order_id']);

const nowLocal = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export class IngestPipeline {
  /**
   * @param repo     ingest repository
   * @param clients  Map of client_id -> client
   * @param deferCutoff  true: a same-day order after 08:00 stays same-day and the Wave Planner decides
   * @param ai       { scorer, anomalies, nextBestAction, capacity, avgDailyOrders, distances, stockMiss(client, region) }
   */
  constructor({ repo, clients, ai, deferCutoff = false }) {
    Object.assign(this, { repo, clients, ai, deferCutoff });
    // Nearest warehouse per region, from the distance table.
    this.nearest = {};
    for (const [wh, regions] of Object.entries(ai.distances)) {
      for (const [region, miles] of Object.entries(regions)) {
        if (!this.nearest[region] || miles < ai.distances[this.nearest[region]][region]) this.nearest[region] = wh;
      }
    }
  }

  /** Process every record of one inbound message. */
  async run({ channel, source, subject, raw, records, fallbackTs }) {
    const started = performance.now();
    const message = await this.repo.createMessage({ channel, source, subject, raw });
    const ledgers = new Map();
    const seen = new Set();
    const results = [];
    for (const rec of records) {
      const r = await this.assess(rec, { channel, fallbackTs, ledgers, seen });
      const row = await this.repo.saveOrder({ ...r, message_id: message.id });
      results.push({ ...r, id: row.id, ref: `IN-${String(row.id).padStart(6, '0')}`, txn: rec.txn });
    }
    const summary = summarise(results, performance.now() - started);
    const status = !results.length || summary.rejected === results.length ? 'rejected'
      : summary.held || summary.rejected ? 'needs_attention' : 'processed';
    return { message: { ...message, status, summary }, results };
  }

  // Record the reply sent back (email text, EDI 997, API response) and close the message.
  finish(messageId, { status, summary, reply }) { return this.repo.finishMessage(messageId, { status, summary, reply }); }

  /** Re-run a held order after the client (or an operator) corrects it. */
  async reprocess(orderId, patch) {
    const row = await this.repo.getOrder(orderId);
    if (!row) return null;
    const n = row.normalized;
    const rec = {
      client_hint: n.client_id, client_sender: n.client_sender, client_order_ref: n.client_order_ref,
      sku: patch.sku ?? n.sku, quantity: patch.quantity ?? n.quantity, service: patch.service ?? n.service_raw ?? n.commitment_type,
      received_ts: n.received_ts, requested_date: n.requested_date, source_ref: n.source_ref,
      ship_to: { ...n.ship_to, ...(patch.ship_to || {}) },
    };
    const r = await this.assess(rec, { channel: n.channel, ledgers: new Map(), seen: new Set(), selfId: row.id });
    const corrections = [...row.corrections, ...r.corrections];
    const updated = await this.repo.updateOrder(row.id, { ...r, corrections });
    return { ...r, corrections, id: updated.id, ref: `IN-${String(updated.id).padStart(6, '0')}` };
  }

  async assess(rec, { channel, fallbackTs, ledgers, seen, selfId }) {
    const { order, corrections } = normalizeOrder(rec);
    order.channel = channel;
    order.received_ts ||= fallbackTs || nowLocal();

    // Duplicates: within this message, then against everything already received.
    if (order.client_id && order.client_order_ref) {
      const key = `${order.client_id}|${order.client_order_ref}`;
      const existing = seen.has(key) ? { id: 'this message' } : await this.repo.findLiveOrder(order.client_id, order.client_order_ref);
      seen.add(key);
      if (existing && existing.id !== selfId) {
        const where = typeof existing.id === 'number' ? `order IN-${String(existing.id).padStart(6, '0')}` : 'earlier in this message';
        return this.result(order, corrections, 'duplicate', [{
          code: 'duplicate_order', severity: 'fatal', field: 'client_order_ref', message: `PO ${order.client_order_ref} was already received (${where})`,
        }]);
      }
    }
    const others = order.client_order_ref && order.client_id ? await this.repo.otherClientsUsingRef(order.client_order_ref, order.client_id) : [];
    const { decision, issues } = validateOrder(order, { clients: this.clients, otherClientsUsingRef: others });
    if (decision === 'reject') return this.result(order, corrections, 'rejected', issues);

    const ai = await this.decide(order, { channel, held: decision === 'hold', ledgers });
    const status = decision === 'hold' ? 'held' : corrections.some((c) => c.rule !== 'formatting') || ai.corrections.length ? 'corrected' : 'accepted';
    return this.result(order, [...corrections, ...ai.corrections], status, [...issues, ...ai.issues], ai);
  }

  // AI layer: promise, anomaly screen, risk score and the carrier decision within capacity.
  async decide(order, { channel, held, ledgers }) {
    const corrections = [];
    const issues = [];
    const client = this.clients.get(order.client_id);
    const region = validateAddress(order.ship_to).region;
    const requested = order.commitment_type || 'standard';
    if (!order.commitment_type) order.commitment_type = 'standard';

    const promise = promiseDelivery({ receivedTs: order.received_ts, commitmentType: requested });
    // Deferred: keep same-day and let the Wave Planner decide; the promise stays on the received date.
    const deferred = this.deferCutoff && promise.afterCutoff && requested === 'same_day';
    if (deferred) {
      issues.push({ code: 'same_day_after_cutoff', severity: 'info', field: 'commitment_type',
        message: `Received ${order.received_ts.slice(11, 16)}, after the 08:00 pick-list cutoff: the Wave Planner decides` });
      promise.promisedDate = order.received_ts.slice(0, 10);
    } else if (promise.offeredCommitment !== requested) {
      corrections.push({ field: 'commitment_type', from: requested, to: promise.offeredCommitment, rule: 'same-day after 8am cutoff re-promised' });
      issues.push({ code: 'same_day_after_cutoff', severity: 'warning', field: 'commitment_type',
        message: `Received ${order.received_ts.slice(11, 16)}, after the 08:00 pick-list cutoff: promised next-day ${promise.promisedDate} instead of same-day` });
    }
    order.commitment_type = deferred ? requested : promise.offeredCommitment;
    order.pick_list_date = promise.pickListDate;

    const hour = Number(order.received_ts.slice(11, 13));
    for (const f of this.ai.anomalies.inspect({
      client_id: order.client_id, order_id: order.client_order_ref, order_channel: channel,
      destination_region: region, commitment_type: requested, received_hour: hour,
    }).findings) {
      if (!COVERED.has(f.code)) issues.push({ code: f.code, severity: 'warning', field: null, message: f.message });
    }

    const warehouse_id = region ? this.nearest[region] : null;
    const features = orderFeatures({
      order_channel: channel, commitment_type: order.commitment_type, received_ts: order.received_ts,
      address_incomplete: held ? 1 : 0, stock_miss: region ? this.ai.stockMiss(order.client_id, region) : 0,
      warehouse_id, destination_region: region, distance_miles: warehouse_id && region ? this.ai.distances[warehouse_id][region] : null, client,
    });
    // Decide for the order as it will ship: a held order ships only after its address is fixed.
    if (!ledgers.has(promise.pickListDate)) {
      ledgers.set(promise.pickListDate, this.ai.capacity.forDay(this.ai.avgDailyOrders, await this.repo.carrierUsage(promise.pickListDate)));
    }
    const ledger = ledgers.get(promise.pickListDate);
    const best = this.ai.nextBestAction.decide({ ...features, address_incomplete: 0 }, { capacity: ledger }).best;
    if (!held) ledger.reserve(best.carrier_id);
    // Kept on the order: the desk may give it another carrier, and says so against this one.
    order.gateway_carrier_id = best.carrier_id;
    const scored = this.ai.scorer.score({ ...features, carrier_id: best.carrier_id });
    if (!held && scored.risk >= RISK_THRESHOLD) {
      issues.push({ code: 'high_late_risk', severity: 'warning', field: null,
        message: `AI predicts a ${Math.round(scored.risk * 100)}% chance this order arrives late; it is on the control-tower watchlist` });
    }
    return {
      corrections, issues,
      risk: scored.risk,
      drivers: scored.drivers.filter((d) => d.impact >= 0.03 && d.value !== 0).slice(0, 3).map(({ feature, impact }) => ({ feature, impact })),
      commitment_type: order.commitment_type,
      promised_date: held ? null : promise.promisedDate,
      warehouse_id,
      carrier_id: best.carrier_id,
    };
  }

  result(order, corrections, status, issues, ai = {}) {
    return {
      source_ref: order.source_ref, client_id: order.client_id || null, client_order_ref: order.client_order_ref,
      status, normalized: order, corrections, issues,
      risk: ai.risk ?? null, drivers: ai.drivers ?? [], commitment_type: ai.commitment_type ?? order.commitment_type,
      promised_date: ai.promised_date ?? null, warehouse_id: ai.warehouse_id ?? null, carrier_id: ai.carrier_id ?? null,
    };
  }
}

export function summarise(results, ms = 0) {
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    orders: results.length, accepted: count('accepted'), corrected: count('corrected'), held: count('held'),
    rejected: count('rejected') + count('duplicate'), duplicates: count('duplicate'),
    auto_fixes: results.reduce((n, r) => n + r.corrections.filter((c) => c.rule !== 'formatting').length, 0),
    ms: Math.round(ms),
  };
}
