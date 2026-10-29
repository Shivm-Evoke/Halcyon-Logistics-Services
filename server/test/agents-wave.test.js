import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWaves } from '../src/agents/wave.js';
import { DEFAULT_SETTINGS as S } from '../src/agents/settings.js';

let n = 0;
const order = (time, extra = {}) => ({
  delivery_id: `D${++n}`, received_ts: `2026-09-25 ${time}`, commitment_type: 'same_day',
  fulfilment_warehouse_id: 'W1', sla: 0, account_status: 'active', ...extra,
});

test('orders before 08:00 make the first pick list; same-day orders up to the second wave join it; later ones wait', () => {
  const a = order('07:59'); const b = order('08:00'); const c = order('12:59'); const d = order('13:00');
  const plan = planWaves([a, b, c, d], S);
  assert.equal(plan.get(a.delivery_id).wave, 1);
  assert.equal(plan.get(b.delivery_id).wave, 2);
  assert.equal(plan.get(c.delivery_id).wave, 2);
  assert.equal(plan.get(d.delivery_id).wave, 'next');
  assert.equal(plan.get(b.delivery_id).agent, 'wave');
});

test('orders after 08:00 that are not same-day stay on tomorrow\'s list: no benefit', () => {
  const s = order('09:00', { commitment_type: 'standard' });
  const p = planWaves([s], S).get(s.delivery_id);
  assert.equal(p.wave, 'next');
  assert.match(p.rule, /no benefit/);
});

test('the wave ranks SLA clients, then accounts threatening to leave, then the earliest order', () => {
  const plain = order('08:05');
  const atRisk = order('09:00', { account_status: 'threatening_to_leave' });
  const sla = order('10:00', { sla: 1 });
  const plan = planWaves([plain, atRisk, sla], { ...S, wave2CapacityPerWarehouse: 2 });
  assert.equal(plan.get(sla.delivery_id).rank, 1);
  assert.equal(plan.get(atRisk.delivery_id).rank, 2);
  assert.equal(plan.get(plain.delivery_id).wave, 'next');
});

test('each warehouse fills its wave to capacity; the overflow needs approval to go over it', () => {
  const orders = Array.from({ length: 31 }, (_, i) => order(`08:${String(i).padStart(2, '0')}`));
  const plan = planWaves(orders, S);
  const waved = orders.filter((o) => plan.get(o.delivery_id).wave === 2);
  assert.equal(waved.length, 30);
  const last = plan.get(orders[30].delivery_id);
  assert.equal(last.wave, 'next');
  assert.equal(last.needsApproval, true);
  assert.match(last.rule, /capacity/);
  // Another warehouse has its own capacity.
  const other = order('08:40', { fulfilment_warehouse_id: 'W2' });
  assert.equal(planWaves([...orders, other], S).get(other.delivery_id).wave, 2);
});
