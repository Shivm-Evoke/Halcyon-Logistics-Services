import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCarriers } from '../src/agents/carrier.js';
import { watch } from '../src/agents/watchtower.js';
import { DEFAULT_SETTINGS as S } from '../src/agents/settings.js';
import { PENALTY_USD, REDELIVERY_USD } from '../src/rules.js';

const P = { A: 0.95, B: 0.94, C: 0.95, D: 0.66, E: 0.83, F: 0.8 };
const model = { pOnTime: (o) => P[o.carrier_id] - (o.address_incomplete ? 0.5 : 0) };
const rates = { A: 15, B: 15, C: 16, D: 12.5, E: 13, F: 11.5 };
const roomy = { A: 100, B: 100, C: 100, D: 100, E: 100, F: 100 };
let n = 0;
const order = (extra = {}) => ({ delivery_id: `D${++n}`, commitment_type: 'standard', account_tier: 'Tier 2', sla: 0, account_status: 'active', address_incomplete: 0, ...extra });

test('each order goes to the carrier with the lowest rate plus expected cost of lateness', () => {
  const o = order({ sla: 1 });
  const { assignments } = allocateCarriers([o], { model, limits: roomy, rates, settings: S, isFriday: false });
  const a = assignments.get(o.delivery_id);
  const cost = (c) => rates[c] + (1 - P[c]) * PENALTY_USD;
  const best = Object.keys(P).sort((x, y) => cost(x) - cost(y))[0];
  assert.equal(a.agent, 'carrier');
  assert.equal(a.carrier_id, best);
  assert.ok(Math.abs(a.expectedCost - cost(best)) < 1e-9);
  // Without an SLA clause the cost of lateness is a redelivery.
  const plain = order();
  const b = allocateCarriers([plain], { model, limits: roomy, rates, settings: S, isFriday: false }).assignments.get(plain.delivery_id);
  assert.ok(Math.abs(b.expectedCost - (rates[b.carrier_id] + (1 - P[b.carrier_id]) * REDELIVERY_USD)) < 1e-9);
});

test('same-day and Tier 1 orders only go to carriers A, B or C', () => {
  const cheapP = { ...P, F: 0.99 }; // F would win on cost if allowed
  const m = { pOnTime: (o) => cheapP[o.carrier_id] };
  for (const o of [order({ commitment_type: 'same_day' }), order({ account_tier: 'Tier 1' })]) {
    const a = allocateCarriers([o], { model: m, limits: roomy, rates, settings: S, isFriday: false }).assignments.get(o.delivery_id);
    assert.ok(['A', 'B', 'C'].includes(a.carrier_id), a.carrier_id);
  }
});

test('usage never exceeds limits; when A-C are full the best remaining carrier is used and the rule says so', () => {
  const limits = { A: 1, B: 1, C: 1, D: 10, E: 10, F: 10 };
  const orders = Array.from({ length: 5 }, () => order({ commitment_type: 'same_day' }));
  const { assignments, usage } = allocateCarriers(orders, { model, limits, rates, settings: S, isFriday: false });
  for (const c of Object.keys(limits)) assert.ok((usage[c] || 0) <= limits[c], c);
  const overflow = [...assignments.values()].filter((a) => !['A', 'B', 'C'].includes(a.carrier_id));
  assert.equal(overflow.length, 2);
  assert.match(overflow[0].rule, /capacity/);
});

test('on Fridays A-C limits rise by the pre-booked share', () => {
  const limits = { A: 10, B: 10, C: 10, D: 10, E: 10, F: 10 };
  const orders = Array.from({ length: 36 }, () => order({ commitment_type: 'same_day' }));
  const fri = allocateCarriers(orders, { model, limits, rates, settings: S, isFriday: true }).usage;
  assert.equal((fri.A || 0) + (fri.B || 0) + (fri.C || 0), 36); // 3 x 13 = 39 places
  const thu = allocateCarriers(orders, { model, limits, rates, settings: S, isFriday: false }).usage;
  assert.equal((thu.A || 0) + (thu.B || 0) + (thu.C || 0), 30);
});

test('an extra cost above the cap needs approval and carries a fallback within the cap', () => {
  const pricey = { ...rates, A: 30, B: 30, C: 30 };
  const o = order({ sla: 1 });
  const a = allocateCarriers([o], { model, limits: roomy, rates: pricey, settings: S, isFriday: false }).assignments.get(o.delivery_id);
  // A: 30 + 0.05 x 180 = 39 beats D: 12.5 + 0.34 x 180 = 73.7, but costs 18.50 more than the cheapest rate.
  assert.equal(a.carrier_id, 'A');
  assert.equal(a.needsApproval, true);
  assert.ok(a.extraCost > S.costCapUsd);
  assert.ok(pricey[a.fallbackCarrierId] - Math.min(...Object.values(pricey)) <= S.costCapUsd);
});

test('watchtower upgrades risky orders to the safest carrier with room and flags key clients for a message', () => {
  const risky = order({ address_incomplete: 1, account_tier: 'Tier 1' });
  const fine = order();
  const assignments = new Map([[risky.delivery_id, { carrier_id: 'D' }], [fine.delivery_id, { carrier_id: 'A' }]]);
  const usage = { A: 0, B: 0, C: 0, D: 1 };
  const w = watch([risky, fine], assignments, { model, limits: roomy, usage, settings: S });
  const r = w.get(risky.delivery_id);
  assert.equal(r.agent, 'watchtower');
  assert.equal(r.action, 'upgrade');
  assert.ok(['A', 'C'].includes(r.carrier_id));
  assert.equal(r.notifyClient, true);
  assert.equal(r.needsApproval, true);
  assert.equal(w.get(fine.delivery_id).action, 'none');
  assert.equal(usage.D, 0); // moved off D
});
