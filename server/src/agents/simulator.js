// The simulation engine behind both the live operations day and the six-month replay.
// Real orders arrive as recorded; the agents decide what happens to each one; the outcome model, measured on
// Halcyon's own history, gives each decided order its chance of arriving on time. Results are expected values
// from seeded decisions, so the same settings always give the same answer.
import { OutcomeModel } from './outcomes.js';
import { CarrierCapacity } from '../ml/CarrierCapacity.js';
import { intakeDecide } from './intake.js';
import { planWaves } from './wave.js';
import { StockAgent } from './stock.js';
import { allocateCarriers, dayLimits, withinCap } from './carrier.js';
import { watch } from './watchtower.js';
import { PENALTY_USD, REDELIVERY_USD } from '../rules.js';

export const AGENT_ORDER = ['intake', 'wave', 'stock', 'carrier', 'watchtower'];
const NONE = Object.fromEntries(AGENT_ORDER.map((a) => [a, false]));

export const dayOf = (o) => String(o.received_ts).slice(0, 10);
export const isFriday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() === 5;
const weekOf = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** One random stream per day, so each day's decisions do not depend on the days before it. */
export const randForDay = (seed, day) => mulberry32(hash(`${seed}|${day}`));

export const approvalKey = (d) => (d.agent === 'stock' && d.pair ? `stock:${d.pair}` : `${d.agent}:${d.delivery_id}`);

/**
 * Applies the enabled agents to one day's orders.
 * ctx: { settings, model, distances, rates, limits, stockPairs:Set, isFriday, rand, approvals?:Map, autoApprove? }
 * A decision that needs approval takes effect only when approved, or with autoApprove (the replay) — except a wave
 * over capacity, which the replay never assumes.
 */
export function simulateDay(dayOrders, ctx) {
  const { settings, model, distances, rates, limits, stockPairs = new Set(), rand } = ctx;
  const on = settings.agents;
  const decisions = [];
  const ok = (d, id) => !d.needsApproval || ctx.approvals?.get(approvalKey({ ...d, delivery_id: id })) === 'approved' || (ctx.autoApprove && d.agent !== 'wave');
  const orders = dayOrders.map((o) => ({ ...o }));

  if (on.intake) {
    for (const o of orders) {
      const d = intakeDecide(o, settings, rand);
      if (!o.address_incomplete) continue;
      decisions.push({ ...d, delivery_id: o.delivery_id });
      if (d.fixAddress && ok(d, o.delivery_id)) o.address_incomplete = 0;
    }
  }
  if (on.stock) {
    for (const o of orders) {
      if (!o.stock_miss || !stockPairs.has(`${o.client_id}|${o.destination_region}`)) continue;
      o.stock_miss = 0;
      o.fulfilment_warehouse_id = o.nearest_warehouse_id;
      o.distance_miles = distances[o.nearest_warehouse_id]?.[o.destination_region] ?? o.distance_miles;
      decisions.push({ agent: 'stock', delivery_id: o.delivery_id, needsApproval: false, rule: 'Stock moved to the nearest warehouse overnight' });
    }
  }
  if (on.wave) {
    const plan = planWaves(orders, settings);
    for (const o of orders) {
      const p = plan.get(o.delivery_id);
      const joins = p.wave === 2 || (p.needsApproval && ok(p, o.delivery_id));
      if (joins && o.commitment_type === 'same_day') o.cutoff_breach = 0;
      if (p.wave === 2 || p.needsApproval) decisions.push({ ...p, delivery_id: o.delivery_id });
    }
  }
  const limitsToday = dayLimits(limits, settings, ctx.isFriday);
  const approvedCarrier = new Map();   // order -> the over-cap carrier a manager approved for it
  if (on.carrier) {
    const { assignments } = allocateCarriers(orders, { model, limits, rates, settings, isFriday: ctx.isFriday });
    for (const o of orders) {
      const a = assignments.get(o.delivery_id);
      const approved = ok(a, o.delivery_id);
      if (a.needsApproval && approved) approvedCarrier.set(o.delivery_id, a.carrier_id);
      o.carrier_id = approved ? a.carrier_id : (a.fallbackCarrierId ?? a.carrier_id);
      decisions.push({ ...a, delivery_id: o.delivery_id });
    }
  }
  const canUse = (o, c) => !on.carrier || withinCap(o, c, rates, settings) || approvedCarrier.get(o.delivery_id) === c;
  if (on.watchtower) {
    const usage = {};
    for (const o of orders) usage[o.carrier_id] = (usage[o.carrier_id] || 0) + 1;
    const current = new Map(orders.map((o) => [o.delivery_id, { carrier_id: o.carrier_id }]));
    const watched = watch(orders, current, { model, limits: limitsToday, usage, settings, canUse });
    for (const o of orders) {
      const w = watched.get(o.delivery_id);
      if (w.action === 'upgrade') o.carrier_id = w.carrier_id;
      if (w.action === 'upgrade' || w.notifyClient && w.risk >= settings.watchtowerRiskMin) decisions.push({ ...w, delivery_id: o.delivery_id });
    }
  }
  for (const o of orders) o.pOnTime = model.pOnTime(o);
  return { decided: orders, decisions };
}

/** Everything a day needs that comes from the whole history: the outcome model and carrier capacity. */
export function buildWorld(orders, settings) {
  return {
    model: OutcomeModel.fromHistory(orders),
    capacity: CarrierCapacity.fromHistory(orders.map((o) => ({ day: dayOf(o), carrier_id: o.carrier_id })), { headroom: settings.carrierHeadroom }),
  };
}

export function groupDays(orders) {
  const days = new Map();
  for (const o of orders) {
    if (!days.has(dayOf(o))) days.set(dayOf(o), []);
    days.get(dayOf(o)).push(o);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Runs all orders day by day under the settings and reports actual against with-agents.
 * @param csComplaintHoursPerWeek customer success hours spent on complaints in the time-study week (461)
 * @param penaltyUsdPerLateSla     penalties actually paid divided by late SLA deliveries (not every late SLA order is charged)
 */
export function runReplay(orders, { settings, distances, rates, csComplaintHoursPerWeek = 461, penaltyUsdPerLateSla = PENALTY_USD }) {
  if (!orders.length) {
    return { overall: { actual: null, agents: null }, weekly: [], waterfall: [], money: { extraCarrierUsd: 0, penaltiesSavedUsd: 0, redeliverySavedUsd: 0, csHoursSavedPerWeek: 0, netUsd: 0 }, accounts: [] };
  }
  const { model, capacity } = buildWorld(orders, settings);
  const days = groupDays(orders);

  const run = (agents) => {
    const stock = new StockAgent(settings);
    const out = [];
    for (const [day, dayOrders] of days) {
      let pairs = new Set();
      if (agents.stock) {
        // The replay approves every transfer, including those over the nightly limit.
        const plan = stock.planTransfers();
        pairs = new Set([...plan.pairs, ...plan.decisions.map((d) => d.pair)]);
        stock.commit(pairs);
      }
      const { decided } = simulateDay(dayOrders, {
        settings: { ...settings, agents }, model, distances, rates,
        limits: capacity.forDay(dayOrders.length).limits, stockPairs: pairs,
        isFriday: isFriday(day), rand: randForDay(settings.seed, day), autoApprove: true,
      });
      stock.observe(dayOrders);
      out.push(...decided);
    }
    return out;
  };

  const waterfall = [{ agent: 'baseline', onTime: mean(run(NONE).map((o) => o.pOnTime)) }];
  const enabled = { ...NONE };
  let final;
  for (const name of AGENT_ORDER) {
    enabled[name] = settings.agents[name];
    final = run({ ...enabled });
    waterfall.push({ agent: name, onTime: mean(final.map((o) => o.pOnTime)) });
  }

  const byId = new Map(final.map((o) => [o.delivery_id, o]));
  const pAgents = (o) => byId.get(o.delivery_id).pOnTime;
  const actualOf = (xs) => mean(xs.map((o) => (o.late ? 0 : 1)));
  const agentsOf = (xs) => mean(xs.map(pAgents));

  const weeks = new Map();
  for (const o of orders) {
    const w = weekOf(dayOf(o));
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(o);
  }
  const weekly = [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, xs]) => ({ week, actual: actualOf(xs), agents: agentsOf(xs) }));

  // Money: a late delivery avoided saves, on SLA contracts, the penalty paid per late order on average, and a redelivery; customer success hours scale
  // with the number of late deliveries (461 complaint hours in the time-study week against that period's weekly lates).
  const lateActual = orders.reduce((s, o) => s + (o.late ? 1 : 0), 0);
  const avoided = (xs) => xs.reduce((s, o) => s + (o.late ? 1 : 0) - (1 - pAgents(o)), 0);
  const lateAvoided = avoided(orders);
  const weeksCount = days.length / 7;
  const csHoursPerLate = lateActual ? csComplaintHoursPerWeek / (lateActual / weeksCount) : 0;
  const rateOf = (c, o) => rates[c] ?? o.carrier_rate_usd ?? 0;
  const extraCarrierUsd = orders.reduce((s, o) => s + rateOf(byId.get(o.delivery_id).carrier_id, o) - rateOf(o.carrier_id, o), 0);
  const penaltiesSavedUsd = avoided(orders.filter((o) => o.sla)) * penaltyUsdPerLateSla;
  const redeliverySavedUsd = lateAvoided * REDELIVERY_USD;

  const atRisk = new Map();
  for (const o of orders) {
    if (o.account_status !== 'threatening_to_leave') continue;
    if (!atRisk.has(o.client_id)) atRisk.set(o.client_id, { client_id: o.client_id, client_name: o.client_name, orders: [] });
    atRisk.get(o.client_id).orders.push(o);
  }

  return {
    overall: { actual: actualOf(orders), agents: waterfall.at(-1).onTime, orders: orders.length },
    weekly,
    waterfall,
    money: {
      extraCarrierUsd,
      penaltiesSavedUsd,
      redeliverySavedUsd,
      csHoursSavedPerWeek: weeksCount ? (lateAvoided / weeksCount) * csHoursPerLate : 0,
      netUsd: penaltiesSavedUsd + redeliverySavedUsd - extraCarrierUsd,
    },
    accounts: [...atRisk.values()].map(({ orders: xs, ...a }) => ({ ...a, orders: xs.length, actual: actualOf(xs), agents: agentsOf(xs) })),
  };
}
