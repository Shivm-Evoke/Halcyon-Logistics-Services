import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLog } from '../src/agents/log.js';
import { simulateDay, approvalKey } from '../src/agents/simulator.js';
import { DEFAULT_SETTINGS as S } from '../src/agents/settings.js';

const row = (approval) => ({ run_id: 'r1', sim_ts: '2026-09-25 09:00', agent: 'carrier', delivery_id: 'D1', decision: {}, rule: 'x', reason: 'x', reason_source: 'rules only', approval });

test('approving a pending decision changes it once; a second click changes nothing', async () => {
  const log = createMemoryLog();
  const [{ id }] = await log.insert([row('pending')]);
  const first = await log.setApproval(id, 'approved', 'manager');
  assert.equal(first.changed, true);
  assert.equal(first.row.approval, 'approved');
  const second = await log.setApproval(id, 'rejected', 'manager');
  assert.equal(second.changed, false);
  assert.equal(second.row.approval, 'approved');
});

test('an expired or automatic decision cannot be approved', async () => {
  const log = createMemoryLog();
  const [a, b] = await log.insert([row('expired'), row('auto')]);
  assert.equal((await log.setApproval(a.id, 'approved', 'm')).changed, false);
  assert.equal((await log.setApproval(b.id, 'approved', 'm')).changed, false);
});

test('list filters by run, agent and approval', async () => {
  const log = createMemoryLog();
  await log.insert([row('pending'), { ...row('auto'), agent: 'wave' }, { ...row('pending'), run_id: 'r2' }]);
  assert.equal((await log.list({ runId: 'r1' })).length, 2);
  assert.equal((await log.list({ runId: 'r1', approval: 'pending' })).length, 1);
  assert.equal((await log.list({ runId: 'r1', agent: 'wave' })).length, 1);
});

test('a decision that needs approval is not carried out until approved', () => {
  // Carrier A wins on expected cost but is $18.50 dearer than F, over the $6 cap.
  const model = { pOnTime: (o) => ({ A: 0.95, F: 0.6 }[o.carrier_id]) };
  const order = { delivery_id: 'D1', received_ts: '2026-09-24 06:00', commitment_type: 'standard', account_tier: 'Tier 2', sla: 1, carrier_id: 'F', address_incomplete: 0, stock_miss: 0, cutoff_breach: 0 };
  const ctx = (approvals) => ({
    settings: { ...S, agents: { intake: false, wave: false, stock: false, carrier: true, watchtower: false } },
    model, distances: {}, rates: { A: 30, F: 11.5 }, limits: { A: 10, F: 10 }, isFriday: false, rand: () => 0.5, approvals,
  });
  const pending = simulateDay([order], ctx(new Map()));
  const d = pending.decisions.find((x) => x.agent === 'carrier');
  assert.equal(d.carrier_id, 'A');
  assert.equal(d.needsApproval, true);
  assert.equal(pending.decided[0].carrier_id, 'F');            // fallback within the cap
  const approved = simulateDay([order], ctx(new Map([[approvalKey(d), 'approved']])));
  assert.equal(approved.decided[0].carrier_id, 'A');
});

test('review fix: per-order stock decisions each get their own key', () => {
  assert.notEqual(approvalKey({ agent: 'stock', delivery_id: 'D1' }), approvalKey({ agent: 'stock', delivery_id: 'D2' }));
  assert.equal(approvalKey({ agent: 'stock', pair: 'C1|West' }), 'stock:C1|West');
});

test('review fix: the watchtower cannot undo an unapproved or rejected carrier choice', () => {
  // A wins on expected cost but is $10 dearer than D, over the $6 cap; the watchtower would like A too.
  const model = { pOnTime: (o) => ({ A: 0.95, D: 0.3 }[o.carrier_id]) };
  const orders = ['D1', 'D2', 'D3'].map((id) => ({ delivery_id: id, received_ts: '2026-09-24 06:00', commitment_type: 'standard', account_tier: 'Tier 2', sla: 1, carrier_id: 'D', address_incomplete: 0, stock_miss: 0, cutoff_breach: 0 }));
  const ctx = (approvals) => ({
    settings: { ...S, agents: { intake: false, wave: false, stock: false, carrier: true, watchtower: true } },
    model, distances: {}, rates: { A: 20, D: 10 }, limits: { A: 10, D: 10 }, isFriday: false, rand: () => 0.5, approvals,
  });
  assert.deepEqual(simulateDay(orders, ctx(new Map())).decided.map((o) => o.carrier_id), ['D', 'D', 'D']);
  const rejected = new Map(orders.map((o) => [`carrier:${o.delivery_id}`, 'rejected']));
  assert.deepEqual(simulateDay(orders, ctx(rejected)).decided.map((o) => o.carrier_id), ['D', 'D', 'D']);
  const approved = new Map(orders.map((o) => [`carrier:${o.delivery_id}`, 'approved']));
  assert.deepEqual(simulateDay(orders, ctx(approved)).decided.map((o) => o.carrier_id), ['A', 'A', 'A']);
});

test('review fix: a same-day order over the cap falls back to the cheapest of A, B and C, never D, E or F', () => {
  const model = { pOnTime: (o) => ({ A: 0.95, B: 0.7, F: 0.5 }[o.carrier_id]) };
  const o = { delivery_id: 'S1', received_ts: '2026-09-24 06:00', commitment_type: 'same_day', account_tier: 'Tier 2', sla: 1, carrier_id: 'F', address_incomplete: 0, stock_miss: 0, cutoff_breach: 0 };
  const { decided, decisions } = simulateDay([o], {
    settings: { ...S, agents: { intake: false, wave: false, stock: false, carrier: true, watchtower: false } },
    model, distances: {}, rates: { A: 30, B: 18, F: 10 }, limits: { A: 10, B: 10, F: 10 }, isFriday: false, rand: () => 0.5, approvals: new Map(),
  });
  const d = decisions.find((x) => x.agent === 'carrier');
  assert.equal(d.carrier_id, 'A');
  assert.equal(d.needsApproval, true);       // $12 above B, the cheapest allowed carrier
  assert.equal(decided[0].carrier_id, 'B');
});
