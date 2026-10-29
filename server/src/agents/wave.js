// Wave Planner agent: a second pick list between the 08:00 cutoff and the 14:00-18:00 carrier collection.
// Same-day orders received after 08:00 otherwise wait for tomorrow's list and are late (39% on time in the data);
// next-day and standard orders received after 08:00 show no such penalty, so they gain nothing from the wave.
import { minutesOf } from './settings.js';
import { PICK_LIST_CUTOFF } from '../rules.js';

const timeOf = (o) => minutesOf(String(o.received_ts).slice(11, 16));

// SLA clients first, then accounts threatening to leave, then first come first served.
const priority = (a, b) => (b.sla - a.sla)
  || ((b.account_status === 'threatening_to_leave') - (a.account_status === 'threatening_to_leave'))
  || (timeOf(a) - timeOf(b));

/** @returns {Map<string, { agent:'wave', wave: 1|2|'next', needsApproval:boolean, rank:number|null, rule:string }>} */
export function planWaves(dayOrders, settings) {
  const cutoff = minutesOf(PICK_LIST_CUTOFF);
  const second = minutesOf(settings.secondWaveAt);
  const plan = new Map();
  const set = (o, wave, rule, extra = {}) => plan.set(o.delivery_id, { agent: 'wave', wave, needsApproval: false, rank: null, rule, ...extra });
  const candidates = new Map();

  for (const o of dayOrders) {
    const t = timeOf(o);
    if (t < cutoff) set(o, 1, `Received before the ${PICK_LIST_CUTOFF} pick list`);
    else if (o.commitment_type !== 'same_day') set(o, 'next', 'Not same-day: tomorrow\'s list still meets the promise (no benefit)');
    else if (t >= second) set(o, 'next', `Received after the ${settings.secondWaveAt} second wave`);
    else {
      const w = o.fulfilment_warehouse_id;
      if (!candidates.has(w)) candidates.set(w, []);
      candidates.get(w).push(o);
    }
  }
  for (const orders of candidates.values()) {
    orders.sort(priority).forEach((o, i) => {
      if (i < settings.wave2CapacityPerWarehouse) set(o, 2, `Second wave at ${settings.secondWaveAt}, priority ${i + 1}`, { rank: i + 1 });
      else set(o, 'next', `Second wave at ${o.fulfilment_warehouse_id} is at capacity (${settings.wave2CapacityPerWarehouse}); approve to add it over capacity`, { needsApproval: true });
    });
  }
  return plan;
}
