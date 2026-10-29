// Watchtower agent: re-scores every order once carriers are assigned and moves the risky ones to the safest
// carrier that still has room. Key clients (Tier 1, or threatening to leave) also get a proactive message,
// which a manager approves before it is sent. Same-day and Tier 1 orders stay with A, B or C, as the carrier agent requires.
import { PREMIUM, restricted } from './carrier.js';

const MIN_GAIN = 0.05; // a move must cut the risk of being late by at least 5 points to be worth the disruption

/** Key clients (Tier 1, or threatening to leave) get a proactive message, which a manager approves before it is sent. */
export const needsClientNotice = (o) => o.account_tier === 'Tier 1' || o.account_status === 'threatening_to_leave';

/**
 * @param usage  mutable { carrier_id: orders assigned today } from the carrier agent; upgrades move counts in place
 * @param canUse (order, carrier) => whether a move there stays within the approved cost limits
 * @returns {Map<string, { agent:'watchtower', action:'none'|'upgrade', carrier_id, risk, notifyClient, needsApproval, rule }>}
 */
export function watch(dayOrders, assignments, { model, limits, usage, settings, canUse = () => true }) {
  const out = new Map();
  for (const o of dayOrders) {
    const current = assignments.get(o.delivery_id)?.carrier_id ?? o.carrier_id;
    const risk = 1 - model.pOnTime({ ...o, carrier_id: current });
    if (risk < settings.watchtowerRiskMin) {
      out.set(o.delivery_id, { agent: 'watchtower', action: 'none', carrier_id: current, risk, notifyClient: false, needsApproval: false, rule: 'Risk below threshold' });
      continue;
    }
    const better = Object.keys(limits)
      .filter((c) => c !== current && (usage[c] || 0) < limits[c] && (!restricted(o) || PREMIUM.includes(c)) && canUse(o, c))
      .map((c) => ({ c, risk: 1 - model.pOnTime({ ...o, carrier_id: c }) }))
      .sort((a, b) => a.risk - b.risk)[0];
    const upgrade = better && risk - better.risk >= MIN_GAIN;
    if (upgrade) {
      usage[current] = Math.max(0, (usage[current] || 0) - 1);
      usage[better.c] = (usage[better.c] || 0) + 1;
    }
    const notifyClient = needsClientNotice(o);
    out.set(o.delivery_id, {
      agent: 'watchtower',
      action: upgrade ? 'upgrade' : 'none',
      carrier_id: upgrade ? better.c : current,
      risk: upgrade ? better.risk : risk,
      notifyClient,
      needsApproval: notifyClient,
      rule: upgrade
        ? `Risk of being late ${Math.round(risk * 100)}% on ${current}: moved to ${better.c} (${Math.round(better.risk * 100)}%)`
        : `Risk of being late ${Math.round(risk * 100)}%: no carrier with room is meaningfully safer`,
    });
  }
  return out;
}
