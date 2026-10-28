import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CarrierCapacity } from '../src/ml/CarrierCapacity.js';
import { NextBestAction } from '../src/ml/NextBestAction.js';

const carriers = [{ carrier_id: 'A', avg_rate: 16 }, { carrier_id: 'B', avg_rate: 16 }, { carrier_id: 'D', avg_rate: 13 }];
// A is the best carrier for everyone, B close behind, D poor.
const scorer = { risk: (o) => ({ A: 0.04, B: 0.06, D: 0.4 }[o.carrier_id]) };
const history = [
  ...Array.from({ length: 8 }, () => ({ day: '2026-09-01', carrier_id: 'A' })),
  ...Array.from({ length: 8 }, () => ({ day: '2026-09-01', carrier_id: 'B' })),
  ...Array.from({ length: 8 }, () => ({ day: '2026-09-01', carrier_id: 'D' })),
];

test('limits come from the historical peak day plus headroom, capped by a share of the day', () => {
  const cap = CarrierCapacity.fromHistory(history, { headroom: 0.25, maxShare: 0.4 });
  assert.equal(cap.peakLimit.A, 10);                   // peak 8 x 1.25
  assert.equal(cap.limitFor('A', 10), 4);              // 40% of a 10-order day binds first
  assert.equal(cap.limitFor('A', 100), 10);            // on a big day the peak limit binds
  assert.equal(cap.limitFor('Z', 100), 0);             // unknown carrier has no capacity
});

test('allocation never exceeds a carrier limit and gives scarce capacity to the highest-regret orders', () => {
  const cap = CarrierCapacity.fromHistory(history, { headroom: 0.25, maxShare: 0.4 });
  const nba = new NextBestAction(scorer, { carriers });
  const orders = Array.from({ length: 10 }, (_, i) => ({ id: i, commitment_type: 'standard', sla: i < 3 ? 1 : 0 }));
  const { assignments, usage, limits } = nba.allocate(orders, cap.forDay(orders.length));
  assert.equal(assignments.length, 10);
  for (const c of Object.keys(usage)) assert.ok(usage[c] <= limits[c], `${c} over capacity`);
  assert.equal(usage.A, 4);
  assert.equal(usage.B, 4);
  // SLA orders lose most by missing a good carrier, so they get A or B.
  for (const a of assignments.filter((x) => x.order.sla)) assert.notEqual(a.choice.carrier_id, 'D');
});

test('single-order decisions skip a carrier that is already full today', () => {
  const cap = CarrierCapacity.fromHistory(history, { headroom: 0.25, maxShare: 0.4 });
  const nba = new NextBestAction(scorer, { carriers });
  const day = cap.forDay(10);
  for (let i = 0; i < 4; i++) day.reserve('A');
  const d = nba.decide({ commitment_type: 'standard', sla: 1 }, { capacity: day });
  assert.equal(d.best.carrier_id, 'B');
  assert.equal(d.options.find((o) => o.carrier_id === 'A').full, true);
});
