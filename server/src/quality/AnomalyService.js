// Screens incoming client orders: learns each client's normal pattern from history, then flags
// orders that break it or carry known data defects. Scores the September feed as "incoming".
import { ClientProfiler } from './ClientProfiler.js';

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

export class AnomalyService {
  /** @param rows delivery rows with client_id, order_id, channel, region, commitment, hour, address flag */
  constructor(rows, { profileUntil }) {
    this.history = rows.filter((r) => r.order_received_ts < profileUntil);
    this.incoming = rows.filter((r) => r.order_received_ts >= profileUntil);
    this.profiler = new ClientProfiler().fit(this.history);
    // order_id -> set of clients, to catch the same reference sent by different clients.
    this.clientsByOrderId = new Map();
    for (const r of rows) {
      if (!this.clientsByOrderId.has(r.order_id)) this.clientsByOrderId.set(r.order_id, new Set());
      this.clientsByOrderId.get(r.order_id).add(r.client_id);
    }
    this.report = null;
  }

  inspect(order, { addressIssues } = {}) {
    const owners = this.clientsByOrderId.get(order.order_id);
    const others = owners && [...owners].some((c) => c !== order.client_id) ? new Set([order.order_id]) : undefined;
    const findings = this.profiler.inspect(order, { otherClientOrderIds: others, addressIssues });
    return { findings, score: findings.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity], 0) };
  }

  // Every incoming order screened once; summary by finding type and by client, plus the flagged rows.
  scanIncoming() {
    if (this.report) return this.report;
    const started = performance.now();
    const byCode = {}; const byClient = {}; const flagged = [];
    for (const r of this.incoming) {
      const { findings, score } = this.inspect(r);
      if (!findings.length) continue;
      flagged.push({ delivery_id: r.delivery_id, order_id: r.order_id, client_id: r.client_id, client_name: r.client_name,
        received: r.order_received_ts, channel: r.order_channel, region: r.destination_region, late: r.late, score, findings });
      for (const f of findings) {
        byCode[f.code] ??= { code: f.code, severity: f.severity, count: 0 };
        byCode[f.code].count++;
      }
      byClient[r.client_id] ??= { client_id: r.client_id, client_name: r.client_name, orders: 0, flagged: 0, score: 0 };
      byClient[r.client_id].flagged++;
      byClient[r.client_id].score += score;
    }
    for (const r of this.incoming) if (byClient[r.client_id]) byClient[r.client_id].orders++;
    const lateRate = (xs) => xs.reduce((s, x) => s + x.late, 0) / (xs.length || 1);
    const flaggedIds = new Set(flagged.map((f) => f.delivery_id));
    this.report = {
      screened: this.incoming.length,
      flagged: flagged.length,
      ms_total: performance.now() - started,
      late_rate_flagged: lateRate(flagged),
      late_rate_clean: lateRate(this.incoming.filter((r) => !flaggedIds.has(r.delivery_id))),
      by_code: Object.values(byCode).sort((a, b) => b.count - a.count),
      by_client: Object.values(byClient).sort((a, b) => b.score - a.score).slice(0, 25),
      rows: flagged.sort((a, b) => b.score - a.score),
    };
    return this.report;
  }
}
