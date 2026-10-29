// Carrier agent: gives each order the carrier with the lowest rate plus expected cost of lateness, within each
// carrier's daily capacity. Same-day and Tier 1 orders only go to A, B or C (95% on time on clean short-haul
// orders, against 66-83% for D, E and F). Friday capacity on A-C is booked from Thursday, ending the Friday overflow onto D.
import { PENALTY_USD, REDELIVERY_USD } from '../rules.js';

export const PREMIUM = ['A', 'B', 'C'];

const restricted = (o) => o.commitment_type === 'same_day' || o.account_tier === 'Tier 1';

/** Today's carrier limits, with A-C raised by the capacity pre-booked for Fridays. */
export function dayLimits(limits, settings, isFriday) {
  const lim = { ...limits };
  if (isFriday) for (const c of PREMIUM) if (lim[c] != null) lim[c] = Math.floor(lim[c] * (1 + settings.fridayPrebookShare));
  return lim;
}

/**
 * @param limits  { carrier_id: max orders today }
 * @param rates   { carrier_id: average rate in USD }
 * @returns {{ assignments: Map<string, { agent:'carrier', carrier_id, expectedCost, extraCost, needsApproval, fallbackCarrierId, rule }>, usage }}
 */
export function allocateCarriers(dayOrders, { model, limits, rates, settings, isFriday }) {
  const lim = dayLimits(limits, settings, isFriday);
  const usage = Object.fromEntries(Object.keys(lim).map((c) => [c, 0]));
  const hasRoom = (c) => usage[c] < lim[c];
  const cheapest = Math.min(...Object.values(rates));
  const carriers = Object.keys(rates).filter((c) => c in lim);

  const prepared = dayOrders.map((o) => {
    const lateCost = o.sla ? PENALTY_USD : REDELIVERY_USD;
    const all = carriers
      .map((c) => ({ c, cost: rates[c] + (1 - model.pOnTime({ ...o, carrier_id: c })) * lateCost }))
      .sort((a, b) => a.cost - b.cost);
    const allowed = restricted(o) ? all.filter((x) => PREMIUM.includes(x.c)) : all;
    // Orders that lose most by missing their best carrier choose first.
    const regret = allowed.length > 1 ? allowed[1].cost - allowed[0].cost : 0;
    return { o, all, allowed, regret };
  }).sort((a, b) => b.regret - a.regret);

  const assignments = new Map();
  for (const { o, all, allowed } of prepared) {
    let pick = allowed.find((x) => hasRoom(x.c));
    let rule = restricted(o) ? 'Lowest expected cost among A, B and C (same-day or Tier 1)' : 'Lowest rate plus expected cost of lateness';
    if (!pick) {
      pick = all.find((x) => hasRoom(x.c)) || all[0];
      rule = restricted(o) ? 'A, B and C at capacity today: best remaining carrier' : 'All preferred carriers at capacity: best remaining carrier';
    }
    usage[pick.c] = (usage[pick.c] || 0) + 1;
    const extraCost = rates[pick.c] - cheapest;
    const needsApproval = extraCost > settings.costCapUsd;
    const fallback = needsApproval ? all.find((x) => x.c !== pick.c && rates[x.c] - cheapest <= settings.costCapUsd && hasRoom(x.c)) : null;
    assignments.set(o.delivery_id, {
      agent: 'carrier',
      carrier_id: pick.c,
      expectedCost: pick.cost,
      extraCost,
      needsApproval,
      fallbackCarrierId: fallback?.c ?? null,
      rule: needsApproval ? `${rule}; $${extraCost.toFixed(2)} above the cheapest carrier, over the $${settings.costCapUsd} cap` : rule,
    });
  }
  return { assignments, usage };
}
