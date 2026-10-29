// The live order desk: runs the five agents over the orders the gateway took in the current desk run, records
// their decisions (one row per agent and order, kept up to date), writes what they decided onto the orders and
// moves each order through its stages on the ops clock. Every operation runs to completion before the next starts.
import { toAgentOrder, deskDecide } from './mapping.js';
import { effectsOf } from './effects.js';
import { clockNow, runIdOf, nextEvent, dueStage } from './clock.js';
import { buildWorld, randForDay, isFriday, groupDays, approvalKey, AGENT_ORDER } from '../agents/simulator.js';
import { StockAgent } from '../agents/stock.js';
import { DEFAULT_SETTINGS } from '../agents/settings.js';
import { nextStage, stageOf, initialStage } from '../shipments/stages.js';
import { orderRef, idFromRef } from '../shipments/views.js';
import { PICK_LIST_CUTOFF } from '../rules.js';

const EXPIRE_AFTER = 120;          // simulated minutes a decision may wait for approval
const MAX_EXPLAINS_PER_RUN = 6;    // Claude explains the most notable new decisions, not all of them
const DECIDED = new Set(['approved', 'rejected']);
const TAKEN = new Set(['auto', 'approved']);

const pad = (n) => String(n).padStart(2, '0');
const minutesOf = (ts) => Date.parse(`${String(ts).replace(' ', 'T').slice(0, 16)}:00Z`) / 60000;
// A date column arrives from pg as a Date at local midnight; read it back with local getters.
const dayText = (v) => (v == null ? null : v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10));
const same = (k, a, b) => (k === 'promised_date' ? dayText(a) === dayText(b) : (a ?? null) === (b ?? null));
// Key-order independent JSON (jsonb does not keep key order), to tell whether a stored decision changed.
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v ?? null));
const keyOfRow = (r) => approvalKey({ agent: r.agent, delivery_id: r.delivery_id });
// What staff approve: whether it needs approval and what the agent chose. When this changes the approval starts again.
const choiceOf = (d) => stable({ needsApproval: Boolean(d?.needsApproval), carrier_id: d?.carrier_id, fallbackCarrierId: d?.fallbackCarrierId,
  wave: d?.wave, fixAddress: d?.fixAddress, action: d?.action, notifyClient: d?.notifyClient });
const MAX_PASSES = 3;              // a release or a reset approval re-runs the agents, at most this many times

/**
 * Creates the desk.
 * @param repo       deskRepo-like store (clock, live orders, order updates, notes, decision rows)
 * @param log        decisionLog-like store (insert, expire, setReason)
 * @param shipments  shipmentStore-like store (eventsFor, advance, recordVerdict); events are stamped with the ops clock
 * @param world      async () => { orders (history), distances, rates }
 * @param claude     createClaude() result or null (reasons then stay the rules)
 * @param stockMiss  (clientId, region) => historical share of stock misses; threshold from settings
 * @param enabled    false (DESK=0): the desk does nothing and the gateway's orders stand as they are
 * @returns {{ enabled, refresh, state, setClock, advance, advanceOrder, clockNow, currentClock, idle }}
 */
export function createDesk({
  repo, log, shipments, world, claude = null, settings = DEFAULT_SETTINGS, stockMiss = () => 0,
  now = () => new Date(), enabled = true, logger = console,
}) {
  let clock = null;            // cached desk_clock row, so the gateway can read the ops clock synchronously
  let queue = Promise.resolve();
  let worldPromise = null;
  const pairsByDay = new Map();
  const work = new Set();
  let failing = false;          // the last run threw: orders keep the gateway's values
  let lastOk = null;            // order ids the last successful run covered (this process)

  // Two requests can arrive together: each runs to completion before the next starts.
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  // The clock starts at its default the first time the desk is used.
  const load = async () => {
    clock ??= (await repo.getClock()) ?? (await repo.setClock(clockNow(null, now())));
    return clock;
  };

  const getWorld = () => (worldPromise ??= (async () => {
    const w = await world();
    return { ...w, history: w.orders, ...buildWorld(w.orders, settings) };
  })().catch((e) => { worldPromise = null; throw e; }));

  // What the Stock agent learned from the history before `day`: transfers made on earlier nights stay in place.
  const stockPairs = (history, day) => {
    if (!pairsByDay.has(day)) {
      const stock = new StockAgent(settings);
      for (const [d, xs] of groupDays(history)) {
        if (d >= day) break;
        const plan = stock.planTransfers();
        stock.commit(new Set([...plan.pairs, ...plan.decisions.map((x) => x.pair)]));
        stock.observe(xs);
      }
      pairsByDay.set(day, stock.planTransfers().pairs);
    }
    return pairsByDay.get(day);
  };

  // Each order's shipment events (oldest first) and its stage from them.
  const eventsOf = async (rows) => {
    const events = rows.length ? await shipments.eventsFor(rows.map((r) => r.id)) : [];
    return new Map(rows.map((r) => [r.id, events.filter((e) => e.order_id === r.id)]));
  };
  const stagesOf = async (rows, byOrder = null) => {
    const events = byOrder ?? await eventsOf(rows);
    return new Map(rows.map((r) => [r.id, stageOf(events.get(r.id)) ?? initialStage(r.status)]));
  };

  const explain = (row, client, simTime) => {
    if (!claude?.available) return;
    const p = claude.explain(row.decision, { order: client, simTime })
      .then((r) => (r.source === 'claude' ? log.setReason(row.id, r.text, 'claude') : undefined))
      .catch(() => {});
    work.add(p);
    p.finally(() => work.delete(p));
  };

  async function run(pass = 1) {
    const c = await load();
    const nowTs = clockNow(c, now());
    const runId = runIdOf(c);
    const rows = (await repo.liveOrders(c.run_started_at)).filter((r) => r.normalized?.received_ts);
    const w = await getWorld();

    // The agents decide the whole run again, day by day, with the approvals staff have given.
    const byKey = new Map((await repo.decisions(runId)).map((r) => [keyOfRow(r), r]));
    const approvals = new Map([...byKey].filter(([, r]) => DECIDED.has(r.approval)).map(([k, r]) => [k, r.approval]));
    const agentOrders = rows.map((r) => toAgentOrder(r, { client: r, distances: w.distances, stockMiss, threshold: settings.stockMissThreshold }));
    const decided = [];
    const decisions = [];
    for (const [day, xs] of groupDays(agentOrders)) {
      const out = deskDecide(xs, {
        settings, model: w.model, distances: w.distances, rates: w.rates, limits: w.capacity.forDay(xs.length).limits,
        stockPairs: stockPairs(w.history, day), isFriday: isFriday(day), rand: randForDay(settings.seed, day), approvals,
      });
      decided.push(...out.decided);
      decisions.push(...out.decisions);
    }

    // One row per (agent, order): new decisions are inserted, changed ones updated.
    // A changed choice (another carrier, a wave, now needing approval or not) is a new decision for staff: an earlier
    // approval or rejection does not carry over to it.
    const fresh = [];
    const reset = [];
    for (const d of decisions) {
      const row = byKey.get(approvalKey(d));
      if (!row) fresh.push(d);
      else if (stable(row.decision) !== stable(d) || (row.rule ?? null) !== (d.rule ?? null)) {
        const rule = d.rule ?? null;
        const again = choiceOf(row.decision) !== choiceOf(d) ? { approval: d.needsApproval ? 'pending' : 'auto', sim_ts: nowTs } : null;
        await repo.updateDecision(row.id, { decision: d, rule, ...(again ? { reset: again } : {}) });
        const updated = { ...row, decision: d, rule, ...(again ? { ...again, actor: null, reason: rule, reason_source: 'rules only' } : {}) };
        byKey.set(approvalKey(d), updated);
        if (again) reset.push(updated);
      }
    }
    const inserted = fresh.length ? await log.insert(fresh.map((d) => ({
      run_id: runId, sim_ts: nowTs, agent: d.agent, delivery_id: d.delivery_id, decision: d, rule: d.rule ?? null,
      reason: d.rule ?? null, reason_source: 'rules only', approval: d.needsApproval ? 'pending' : 'auto',
    }))) : [];
    for (const r of inserted) byKey.set(keyOfRow(r), r);

    // A decision waits 120 simulated minutes for approval (or until the agents no longer make it); then the safe option stands.
    const current = new Set(decisions.map(approvalKey));
    const stale = [...byKey].filter(([k, r]) => r.approval === 'pending' && (minutesOf(nowTs) - minutesOf(r.sim_ts) > EXPIRE_AFTER || !current.has(k)));
    if (stale.length) {
      await log.expire(runId, stale.map(([, r]) => r.id));
      for (const [k, r] of stale) byKey.set(k, { ...r, approval: 'expired' });
    }

    // What the agents decided, written onto each order, with a note on its shipment.
    const decidedBy = new Map(decided.map((o) => [o.delivery_id, o]));
    const stages = await stagesOf(rows);
    const waves = new Map();
    let released = false;
    for (const row of rows) {
      const ref = orderRef(row.id);
      const o = decidedBy.get(ref);
      const ds = decisions.filter((d) => d.delivery_id === ref);
      if (!o || !ds.length) continue;
      const fields = {};
      const notes = [];
      for (const d of ds) {
        const approval = byKey.get(approvalKey(d)).approval;
        if (d.agent === 'wave' && (d.wave === 2 || (d.needsApproval && TAKEN.has(approval)))) waves.set(row.id, 2);
        const e = effectsOf(d, o, approval);
        if (!e) continue;
        Object.assign(fields, e.fields);
        notes.push(e.note);
      }
      const { release, ...cols } = fields;
      const changed = Object.fromEntries(Object.entries(cols).filter(([k, v]) => v !== undefined && !same(k, row[k], v)));
      if (release && row.status === 'held') changed.status = 'corrected';
      if (Object.keys(changed).length) {
        await repo.updateOrder(row.id, changed);
        Object.assign(row, changed);
      }
      if (changed.status) {
        released = true;
        await shipments.recordVerdict(row, nowTs);
        stages.set(row.id, initialStage(row.status));
      }
      for (const note of notes) await repo.addNoteOnce(row.id, stages.get(row.id), note, nowTs);
    }

    // A released order joins the other agents' decisions at once; a reset approval no longer steers them.
    if ((released || reset.some((r) => DECIDED.has(approvals.get(keyOfRow(r))))) && pass < MAX_PASSES) return run(pass + 1);

    // Stages move on the ops clock: picked at the order's wave, collected at 14:00, delivered on the promised date.
    for (const row of rows) {
      let stage = stages.get(row.id);
      const receivedTs = String(row.normalized.received_ts).replace('T', ' ').slice(0, 16);
      const wave = waves.get(row.id) ?? (receivedTs.slice(11) < PICK_LIST_CUTOFF ? 1 : null);
      let due = dueStage({ stage, wave, commitment_type: row.commitment_type, promised_date: row.promised_date, received_ts: receivedTs }, nowTs);
      if (due === 'delivered' && !row.promised_date) due = 'in_transit';
      while (stage !== due) {
        const next = nextStage(stage);
        if (!next || !(await shipments.advance(row.id, stage, next, 'ops clock', nowTs))) break;
        stage = next;
      }
    }

    // Claude explains the notable new decisions in the background; the rule stands until it answers.
    const clients = new Map(rows.map((r) => [orderRef(r.id), { client_id: r.client_id, client_name: r.client_name, tier: r.account_tier }]));
    const notable = [...inserted, ...reset].filter(({ decision: d }) => d.needsApproval || d.agent === 'wave' || d.agent === 'watchtower'
      || (d.agent === 'intake' && d.fixAddress) || (d.agent === 'carrier' && d.carrier_id !== decidedBy.get(d.delivery_id)?.gateway_carrier_id))
      .sort((a, b) => (b.decision.needsApproval ? 1 : 0) - (a.decision.needsApproval ? 1 : 0)).slice(0, MAX_EXPLAINS_PER_RUN);
    for (const r of notable) explain(r, clients.get(r.delivery_id), nowTs.slice(11));
    return rows.map((r) => r.id);
  }

  // A run that throws leaves the orders as the gateway made them; the desk shows them as "agents not run".
  async function refresh() {
    if (!enabled) return;
    try {
      lastOk = new Set(await run());
      failing = false;
    } catch (e) {
      failing = true;
      logger.error(`Desk run failed: ${e.message}`);
    }
  }

  async function state() {
    const counts = Object.fromEntries(AGENT_ORDER.map((a) => [a, 0]));
    if (!enabled) return { enabled: false, clock: null, orders: [], approvals: [], counts };
    const c = await load();
    const runId = runIdOf(c);
    const rows = await repo.liveOrders(c.run_started_at);
    const refs = new Set(rows.map((r) => orderRef(r.id)));
    const decisionRows = (await repo.decisions(runId)).filter((d) => refs.has(d.delivery_id));
    const events = await eventsOf(rows);
    const stages = await stagesOf(rows, events);
    const client = (r) => ({ client_id: r.client_id, client_name: r.client_name ?? null, account_tier: r.account_tier ?? null });
    const shown = (d) => ({ id: d.id, agent: d.agent, rule: d.rule, reason: d.reason, reason_source: d.reason_source, approval: d.approval, at: d.sim_ts });
    const byRef = new Map(rows.map((r) => [orderRef(r.id), r]));
    for (const d of decisionRows) if (d.agent in counts) counts[d.agent]++;
    return {
      enabled: true,
      clock: { now: clockNow(c, now()), runId },
      orders: rows.map((r) => ({
        ref: orderRef(r.id),
        client: client(r),
        channel: r.channel ?? null,
        status: r.status,
        received_ts: r.normalized?.received_ts ? String(r.normalized.received_ts).replace('T', ' ').slice(0, 16) : null,
        stage: stages.get(r.id),
        commitment_type: r.commitment_type ?? null,
        promised_date: dayText(r.promised_date),
        carrier_id: r.carrier_id ?? null,
        warehouse_id: r.warehouse_id ?? null,
        risk: r.risk == null ? null : Number(r.risk),
        // The shipment's timeline, at the ops clock: stage moves and the agents' notes, oldest first.
        events: events.get(r.id).map(({ stage, at, by, note }) => ({ stage, at: String(at).replace('T', ' ').slice(0, 16), by, note: note ?? null })),
        checks: [
          ...(r.issues || []).map((i) => ({ kind: 'issue', ...i })),
          ...(r.corrections || []).filter((x) => x.rule !== 'formatting').map((x) => ({ kind: 'correction', ...x })),
        ],
        decisions: decisionRows.filter((d) => d.delivery_id === orderRef(r.id)).map(shown),
        agentsRun: !failing || Boolean(lastOk?.has(r.id)),
      })),
      approvals: decisionRows.filter((d) => d.approval === 'pending').map((d) => ({ ...shown(d), ref: d.delivery_id, client: client(byRef.get(d.delivery_id)) })),
      counts,
    };
  }

  return {
    /** False with DESK=0. */
    enabled,
    /** Runs the agents over the run's live orders and applies what they decided. Never throws. */
    refresh: () => serial(refresh),
    /** The desk as staff see it: clock, live orders with checks and decisions, pending approvals, counts per agent. */
    state: () => serial(state),
    /** Sets the ops clock ('YYYY-MM-DD HH:MM'), starting a new run, and returns the state. */
    setClock: (setTo) => serial(async () => {
      if (!enabled) return state();
      clock = await repo.setClock(setTo);
      await refresh();
      return state();
    }),
    /** Moves the clock to the next event (08:00, 13:00, 14:00, end of day) in the same run, and returns the state. */
    advance: () => serial(async () => {
      if (!enabled) return state();
      const to = nextEvent(clockNow(await load(), now()));
      clock = (await repo.shiftClock(to)) ?? (await repo.setClock(to));
      await refresh();
      return state();
    }),
    /**
     * Moves one live order on by one stage.
     * @returns null when `ref` is not a live order of this run; else { moved, stage, state }
     */
    advanceOrder: (ref) => serial(async () => {
      if (!enabled) return null;
      const c = await load();
      const row = (await repo.liveOrders(c.run_started_at)).find((r) => r.id === idFromRef(ref));
      if (!row) return null;
      const from = (await stagesOf([row])).get(row.id);
      const next = nextStage(from);
      const moved = Boolean(next && (await shipments.advance(row.id, from, next, 'staff', clockNow(c, now()))));
      if (moved) await refresh();
      return { moved, stage: moved ? next : from, state: await state() };
    }),
    /** The ops clock now ('YYYY-MM-DD HH:MM'), or null before the clock is loaded or with the desk off. */
    clockNow: () => (enabled && clock ? clockNow(clock, now()) : null),
    /** The ops clock now, loading it first if needed; null only with the desk off. */
    currentClock: async () => (enabled ? clockNow(await load(), now()) : null),
    /** Resolves when every Claude call started so far has finished (tests). */
    idle: async () => { while (work.size) await Promise.allSettled([...work]); },
  };
}
