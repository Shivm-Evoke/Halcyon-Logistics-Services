// Replays the test month under different policies and reports the on-time rate the model expects.
// Because the model is calibrated on unseen data, mean predicted risk is a fair estimate of the late rate.
// AI policies are replayed one day at a time, with every day's orders sharing that day's carrier capacity.
import { NextBestAction } from './NextBestAction.js';

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
const dayOf = (r) => String(r.order_received_ts).slice(0, 10);

function groupByDay(rows) {
  const days = new Map();
  for (const r of rows) {
    if (!days.has(dayOf(r))) days.set(dayOf(r), []);
    days.get(dayOf(r)).push(r);
  }
  return [...days.values()];
}

function shares(assignedCarriers, carriers) {
  const n = assignedCarriers.length || 1;
  return Object.fromEntries(carriers.map((c) => [c.carrier_id, assignedCarriers.filter((x) => x === c.carrier_id).length / n]));
}

/**
 * @param rows      test-period delivery rows (model features + `late`)
 * @param riskFn    (order) => P(late)
 * @param carriers  [{ carrier_id, avg_rate }]
 * @param distances { warehouse: { region: miles } }
 * @param capacity  CarrierCapacity
 */
export function backtest(rows, riskFn, { carriers, distances, capacity }) {
  const nba = new NextBestAction({ risk: riskFn }, { carriers });
  // What intake validation and safety stock change about an order before it ships.
  const fixData = (r) => ({
    ...r,
    address_incomplete: 0,
    stock_miss: 0,
    fulfilment_warehouse_id: r.nearest_warehouse_id,
    distance_miles: distances[r.nearest_warehouse_id]?.[r.destination_region] ?? r.distance_miles,
  });
  const rateOf = Object.fromEntries(carriers.map((c) => [c.carrier_id, Number(c.avg_rate)]));

  const currentRisk = rows.map(riskFn);
  const fixedRisk = rows.map((r) => riskFn(fixData(r)));
  const unconstrained = rows.map((r) => nba.decide(fixData(r)).best);

  // Capacity-limited: allocate each day's orders together.
  const nbaOnly = []; const full = []; let overCapacity = 0; let peakShare = 0;
  for (const day of groupByDay(rows)) {
    nbaOnly.push(...nba.allocate(day, capacity.forDay(day.length)).assignments);
    const fixedDay = day.map(fixData);
    const result = nba.allocate(fixedDay, capacity.forDay(day.length));
    for (const a of result.assignments) { full.push(a); if (a.choice.over_capacity) overCapacity++; }
    for (const c of Object.keys(result.usage)) peakShare = Math.max(peakShare, result.usage[c] / day.length);
  }

  const costNow = mean(rows.map((r, i) => rateOf[r.carrier_id] + currentRisk[i] * nba.score(r).lateCost));
  const costAi = mean(full.map((a) => a.choice.expected_cost));
  const scenario = (name, risks, description) => ({ name, description, on_time: 1 - mean(risks) });

  return {
    rows: rows.length,
    days: groupByDay(rows).length,
    actual_on_time: 1 - mean(rows.map((r) => r.late)),
    capacity: capacity.toJSON(),
    scenarios: [
      scenario('Today (model estimate)', currentRisk, 'Same orders, same choices: checks the model against reality'),
      scenario('AI carrier + promise choice only', nbaOnly.map((a) => a.choice.risk), 'Next-best-action per order, within daily carrier capacity'),
      scenario('Intake validation + safety stock', fixedRisk, 'Addresses fixed before release; stock at nearest warehouse'),
      scenario('Full AI-driven operation', full.map((a) => a.choice.risk), 'Clean data in, plus capacity-limited next-best-action'),
    ],
    unconstrained_on_time: 1 - mean(unconstrained.map((b) => b.risk)),
    carrier_mix: {
      today: shares(rows.map((r) => r.carrier_id), carriers),
      ai_capacity_limited: shares(full.map((a) => a.choice.carrier_id), carriers),
      ai_unlimited: shares(unconstrained.map((b) => b.carrier_id), carriers),
    },
    peak_daily_share: peakShare,
    over_capacity_orders: overCapacity,
    changed_carrier_share: mean(full.map((a) => (a.choice.carrier_id !== a.order.carrier_id ? 1 : 0))),
    repromised_share: mean(full.map((a) => (a.choice.downgraded ? 1 : 0))),
    expected_cost_per_order: { current: costNow, next_best_action: costAi },
  };
}
