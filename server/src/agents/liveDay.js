// The live operations day: one real day of Halcyon's orders replayed on a simulated clock while the agents work.
// The engine decides the whole day at once (and again whenever a manager's approval changes something); each decision
// is revealed when the clock reaches it: intake, stock and carrier when the order arrives, the second wave at its time,
// the watchtower at the 14:00 collection. Claude explains notable decisions and writes the Ops Lead briefings in the
// background, so the clock never waits for it; a recorded run replays saved Claude output without any network.
import { buildWorld, simulateDay, randForDay, isFriday, dayOf, groupDays, approvalKey, AGENT_ORDER } from './simulator.js';
import { StockAgent } from './stock.js';
import { minutesOf } from './settings.js';

const SLOT = 30;                  // the agents and the clock move in half-hour steps
const EXPIRE_AFTER = 120;         // simulated minutes a decision may wait for approval
const MAX_EXPLAINS_PER_STEP = 6;  // Claude explains the most notable decisions, not all of them
const LANE_SIZE = 40;
const COLLECTION = minutesOf('14:00');

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const atOf = (o) => minutesOf(String(o.received_ts).slice(11, 16));
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** The September 2026 Friday with the lowest recorded on-time rate; for test data without one, its busiest day. */
export function pickDemoDay(orders) {
  const days = new Map();
  for (const o of orders) {
    const d = dayOf(o);
    if (!d.startsWith('2026-09') || !isFriday(d)) continue;
    const s = days.get(d) || { n: 0, ok: 0 };
    s.n++; s.ok += o.late ? 0 : 1;
    days.set(d, s);
  }
  const worst = [...days].sort(([, a], [, b]) => a.ok / a.n - b.ok / b.n)[0]?.[0];
  if (worst) return worst;
  const volume = new Map();
  for (const o of orders) volume.set(dayOf(o), (volume.get(dayOf(o)) || 0) + 1);
  return [...volume].sort(([da, a], [db, b]) => b - a || da.localeCompare(db))[0]?.[0] ?? null;
}

export class LiveDay {
  /**
   * @param orders   all history (the world is measured on it; the day's orders are taken from it)
   * @param claude   createClaude() result; @param log decisionLog-like store
   * @param recorded { reasons: { key: text }, briefings: { 'HH:MM': text } } for mode 'recorded'
   * @param world    { model, capacity } from the history, when `orders` is a test dataset
   * @param history  orders the agents have already seen before `orders` (the real history, for a test dataset)
   */
  constructor({ day, orders, distances, rates, settings, claude, log, mode = 'live', recorded = null, world = null, history = [], label = null, dataset = null }) {
    this.day = day;
    this.label = label;
    this.dataset = dataset;
    this.mode = mode;
    this.settings = settings;
    this.claude = claude;
    this.log = log;
    this.recorded = recorded || { reasons: {}, briefings: {} };
    this.runId = `live-${day}-${Math.random().toString(36).slice(2, 8)}`;
    this.dayOrders = orders.filter((o) => dayOf(o) === day)
      .sort((a, b) => a.received_ts.localeCompare(b.received_ts) || String(a.delivery_id).localeCompare(String(b.delivery_id)));

    // Stock moved on the nights before the demo stays in place; tonight's transfers are the new decisions.
    const stock = new StockAgent(settings);
    for (const [d, xs] of groupDays([...history, ...orders])) {
      if (d >= day) break;
      const plan = stock.planTransfers();
      stock.commit(new Set([...plan.pairs, ...plan.decisions.map((x) => x.pair)]));
      stock.observe(xs);
    }
    const tonight = stock.planTransfers();
    this.stockPairs = tonight.pairs;
    this.stockTransfers = tonight.decisions;

    const { model, capacity } = world || buildWorld(orders, settings);
    this.ctx = { settings, model, distances, rates, limits: capacity.forDay(this.dayOrders.length).limits, isFriday: isFriday(day), autoApprove: false };
    this.approvals = new Map();
    this.events = new Map();   // decision key -> event
    this.briefings = [];
    this.work = new Set();
    this.simMinutes = 0;
    this.queue = Promise.resolve();
    // The same orders with every agent off: the comparison when the test data has no outcomes.
    this.baseline = new Map(simulateDay(this.dayOrders, { ...this.ctx, settings: { ...settings, agents: Object.fromEntries(AGENT_ORDER.map((a) => [a, false])) }, rand: randForDay(settings.seed, day) })
      .decided.map((o) => [o.delivery_id, o.pOnTime]));
    this.recompute();
  }

  // Two tabs, a jump and a poll can arrive together: each runs to completion before the next starts.
  #serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  recompute() {
    const approvedPairs = this.stockTransfers.filter((d) => this.approvals.get(approvalKey(d)) === 'approved').map((d) => d.pair);
    const { decided, decisions } = simulateDay(this.dayOrders, {
      ...this.ctx, stockPairs: new Set([...this.stockPairs, ...approvedPairs]), rand: randForDay(this.settings.seed, this.day), approvals: this.approvals,
    });
    this.decided = decided;
    const byId = new Map(this.dayOrders.map((o) => [o.delivery_id, o]));
    const second = minutesOf(this.settings.secondWaveAt);
    this.planned = [
      ...this.stockTransfers.filter((d) => d.needsApproval).map((d) => ({ d, at: 0 })),
      ...decisions.map((d) => {
        const arrived = atOf(byId.get(d.delivery_id));
        const at = d.agent === 'wave' ? Math.max(arrived, second) : d.agent === 'watchtower' ? Math.max(arrived, COLLECTION) : arrived;
        return { d, at, order: byId.get(d.delivery_id) };
      }),
    ];
    // Revealed decisions keep their identity, reason and approval; their content follows the latest decision.
    for (const { d } of this.planned) {
      const ev = this.events.get(approvalKey(d));
      if (ev) ev.decision = d;
    }
  }

  /** Moves the clock forward, revealing decisions and starting Claude's work for each half-hour passed. */
  advance(minutes) {
    return this.#serial(() => this.#advance(minutes));
  }

  async #advance(minutes) {
    const target = Math.min(24 * 60, this.simMinutes + Math.max(0, minutes));
    const briefAt = new Set(['06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', this.settings.secondWaveAt].map(minutesOf));
    let t = this.simMinutes;
    while (t < target) {
      const next = Math.min(target, (Math.floor(t / SLOT) + 1) * SLOT);
      await this.#reveal(next);
      await this.#expire(next);
      for (const b of briefAt) if (b > t && b <= next) this.#brief(b);
      t = next;
      this.simMinutes = t;
    }
    return this.#state();
  }

  async #reveal(until) {
    const fresh = this.planned.filter(({ d, at }) => at <= until && !this.events.has(approvalKey(d)));
    if (!fresh.length) return;
    const rows = await this.log.insert(fresh.map(({ d, at }) => ({
      run_id: this.runId, sim_ts: `${this.day} ${hhmm(at)}`, agent: d.agent, delivery_id: d.delivery_id ?? null,
      decision: d, rule: d.rule, reason: d.rule, reason_source: 'rules only', approval: d.needsApproval ? 'pending' : 'auto',
    })));
    fresh.forEach(({ d, at, order }, i) => {
      this.events.set(approvalKey(d), {
        id: rows[i].id, key: approvalKey(d), at, simTime: hhmm(at), agent: d.agent, delivery_id: d.delivery_id ?? null,
        decision: d, rule: d.rule, reason: d.rule, reason_source: 'rules only', approval: rows[i].approval,
        notable: d.needsApproval || d.agent === 'wave' || d.agent === 'watchtower' || (d.agent === 'intake' && d.fixAddress)
          || (d.agent === 'carrier' && order && d.carrier_id !== order.carrier_id),
        client: order ? { client_id: order.client_id, client_name: order.client_name, tier: order.account_tier } : null,
      });
    });
    const notable = fresh.map(({ d }) => this.events.get(approvalKey(d))).filter((e) => e.notable)
      .sort((a, b) => (b.decision.needsApproval ? 1 : 0) - (a.decision.needsApproval ? 1 : 0)).slice(0, MAX_EXPLAINS_PER_STEP);
    for (const ev of notable) this.#explain(ev);
  }

  #explain(ev) {
    const save = (text) => {
      Object.assign(ev, { reason: text, reason_source: 'claude' });
      return this.log.setReason?.(ev.id, text, 'claude');
    };
    if (this.mode === 'recorded') {
      const text = this.recorded.reasons[ev.key];
      if (text) this.#track(Promise.resolve(save(text)).catch(() => {}));
      return;
    }
    if (!this.claude?.available) return;
    this.#track(this.claude.explain(ev.decision, { order: ev.client, simTime: ev.simTime }).then((r) => {
      if (r.source === 'claude') return save(r.text);
      return undefined;
    }).catch(() => {}));
  }

  #brief(at) {
    const simTime = hhmm(at);
    const entry = { simTime, text: this.#rulesBriefing(at), source: 'rules only' };
    this.briefings.push(entry);
    if (this.mode === 'recorded') {
      const text = this.recorded.briefings[simTime];
      if (text) Object.assign(entry, { text, source: 'claude' });
      return;
    }
    if (!this.claude?.available) return;
    const summary = this.#summary(at);
    const tools = {
      get_state: async () => summary,
      run_agent: async ({ agent }) => this.planned.filter(({ d, at: when }) => d.agent === agent && when <= at).slice(-20).map(({ d }) => d),
      list_pending_approvals: async () => this.#pending().map(({ id, agent, rule, client }) => ({ id, agent, rule, client })),
      explain_decision: async ({ decision_id }) => [...this.events.values()].find((e) => e.id === decision_id) ?? null,
    };
    this.#track(this.claude.briefing({ simTime, ...summary }, tools).then((r) => {
      if (r.source === 'claude' && r.text) Object.assign(entry, { text: r.text, source: 'claude' });
    }).catch(() => {}));
  }

  #summary(at) {
    const counts = Object.fromEntries(AGENT_ORDER.map((a) => [a, 0]));
    for (const e of this.events.values()) if (e.at <= at) counts[e.agent]++;
    const c = this.#counters(at);
    return { orders: c.orders, onTimeActual: c.actual, onTimeWithoutAgents: c.baseline, onTimeAgents: c.agents, decisions: counts, pendingApprovals: this.#pending().length };
  }

  #rulesBriefing(at) {
    const s = this.#summary(at);
    const waved = [...this.events.values()].filter((e) => e.agent === 'wave' && e.decision.wave === 2).length;
    const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    return `${hhmm(at)}: ${n(s.orders, 'order', 'orders')} in. Expected on time ${pct(s.onTimeAgents)} with the agents (${s.onTimeActual != null ? `recorded ${pct(s.onTimeActual)}` : `${pct(s.onTimeWithoutAgents)} without them`}). `
      + `${n(waved, 'same-day order', 'same-day orders')} in the second wave; ${n(s.decisions.watchtower, 'watchtower action', 'watchtower actions')}; ${n(s.pendingApprovals, 'decision', 'decisions')} awaiting approval.`;
  }

  async #expire(now) {
    const stale = this.#pending().filter((e) => now - e.at > EXPIRE_AFTER);
    if (!stale.length) return;
    await this.log.expire(this.runId, stale.map((e) => e.id));
    for (const e of stale) e.approval = 'expired';
  }

  #pending() { return [...this.events.values()].filter((e) => e.approval === 'pending'); }

  #counters(at) {
    const arrived = this.decided.filter((o) => atOf(o) <= at);
    return {
      orders: arrived.length,
      actual: mean(arrived.filter((o) => o.late != null).map((o) => (o.late ? 0 : 1))),
      baseline: mean(arrived.map((o) => this.baseline.get(o.delivery_id))),
      agents: mean(arrived.map((o) => o.pOnTime)),
    };
  }

  #track(p) {
    this.work.add(p);
    p.finally(() => this.work.delete(p));
  }

  /** Resolves when every Claude call started so far has finished (tests, recording). */
  async idle() {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  /** Picks up approvals made through the API; a change re-decides the day. */
  async #syncApprovals() {
    const rows = await this.log.list({ runId: this.runId, limit: 100000 });
    let changed = false;
    for (const r of rows) {
      const ev = [...this.events.values()].find((e) => e.id === r.id);
      if (ev && ev.approval !== r.approval) ev.approval = r.approval;
      if (ev && (r.approval === 'approved' || r.approval === 'rejected') && this.approvals.get(ev.key) !== r.approval) {
        this.approvals.set(ev.key, r.approval);
        changed = true;
      }
    }
    if (changed) this.recompute();
  }

  state() {
    return this.#serial(() => this.#state());
  }

  async #state() {
    await this.#syncApprovals();
    const lanes = Object.fromEntries(AGENT_ORDER.map((a) => [a, []]));
    const all = [...this.events.values()].sort((a, b) => b.at - a.at || b.id - a.id);
    for (const e of all) if (lanes[e.agent].length < LANE_SIZE) lanes[e.agent].push(e);
    const totals = Object.fromEntries(AGENT_ORDER.map((a) => [a, all.filter((e) => e.agent === a).length]));
    return {
      runId: this.runId, day: this.day, mode: this.mode, label: this.label, dataset: this.dataset, simTime: hhmm(this.simMinutes), simMinutes: this.simMinutes,
      aiAvailable: this.mode === 'recorded' || Boolean(this.claude?.available),
      counters: this.#counters(this.simMinutes), lanes, totals,
      approvals: this.#pending(), briefings: [...this.briefings].reverse(),
    };
  }

  /** Claude output from this run, for the recorded stage backup. */
  recording() {
    const reasons = {};
    for (const e of this.events.values()) if (e.reason_source === 'claude') reasons[e.key] = e.reason;
    const briefings = Object.fromEntries(this.briefings.filter((b) => b.source === 'claude').map((b) => [b.simTime, b.text]));
    return { day: this.day, recordedAt: new Date().toISOString(), reasons, briefings };
  }
}
