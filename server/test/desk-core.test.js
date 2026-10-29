import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgentOrder, deskDecide } from '../src/desk/mapping.js';
import { effectsOf } from '../src/desk/effects.js';
import { buildWorld, randForDay, isFriday } from '../src/agents/simulator.js';
import { DEFAULT_SETTINGS } from '../src/agents/settings.js';

const distances = { W1: { West: 100 } };
const rates = { A: 15, D: 12 };
const DAY = '2026-09-25';
const S = { ...DEFAULT_SETTINGS, addressFixRate: 1 };
const client = { client_name: 'Acme', account_tier: 'Tier 2', account_status: 'active' };
const ship_to = { name: 'A', street: '1 Main St', city: 'Los Angeles', state: 'CA', zip: '90001' };

function history() {
  const rows = [];
  let id = 0;
  for (const day of ['2026-09-18', '2026-09-24', DAY]) {
    for (let i = 0; i < 60; i++) {
      const hour = (i * 23) % 24;
      const sameDay = i % 3 === 0;
      rows.push({
        delivery_id: `${day}-${++id}`, client_id: `C${i % 4}`, client_name: `Client ${i % 4}`, destination_region: 'West',
        received_ts: `${day} ${String(hour).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
        commitment_type: sameDay ? 'same_day' : 'standard', cutoff_breach: sameDay && hour >= 8 ? 1 : 0,
        address_incomplete: i % 5 === 0 ? 1 : 0, stock_miss: 0, nearest_warehouse_id: 'W1', fulfilment_warehouse_id: 'W1',
        distance_miles: 100, carrier_id: i % 2 ? 'D' : 'A', carrier_rate_usd: 12, account_tier: i % 10 === 0 ? 'Tier 1' : 'Tier 2',
        sla: i % 2, account_status: 'active', late: i % 4 === 0 ? 1 : 0,
      });
    }
  }
  return rows;
}

const row = (id, over = {}) => ({
  id, client_id: 'C1', status: 'corrected', warehouse_id: 'W1', carrier_id: 'D', channel: 'EDI',
  normalized: { sku: 'X', quantity: 1, ship_to, commitment_type: 'same_day', received_ts: `${DAY} 09:15` }, ...over,
});
const opts = { client, distances, stockMiss: () => 0, threshold: 0.1 };

test('a corrected same-day EDI order at 09:15 maps with a cutoff breach', () => {
  const o = toAgentOrder(row(7), opts);
  assert.equal(o.delivery_id, 'IN-000007');
  assert.equal(o.order_id, 7);
  assert.equal(o.cutoff_breach, 1);
  assert.equal(o.commitment_type, 'same_day');
  assert.equal(o.order_channel, 'EDI');
  assert.equal(o.destination_region, 'West');
  assert.equal(o.distance_miles, 100);
  assert.equal(o.address_incomplete, 0);
  assert.equal(o.client_name, 'Acme');
});

test('the gateway carrier is the one the gateway chose, not the carrier the desk wrote over it later', () => {
  const changed = row(9, { carrier_id: 'A', normalized: { ...row(9).normalized, gateway_carrier_id: 'B' } });
  assert.equal(toAgentOrder(changed, opts).gateway_carrier_id, 'B');
  assert.equal(toAgentOrder(changed, opts).carrier_id, 'A');
  assert.equal(toAgentOrder(row(10), opts).gateway_carrier_id, 'D');   // orders from before it was kept
});

test('held orders are flagged incomplete, T timestamps are normalised, and stock misses follow the threshold', () => {
  const o = toAgentOrder(row(8, { status: 'held', normalized: { ship_to, commitment_type: 'same_day', received_ts: `${DAY}T07:30` } }), { ...opts, stockMiss: () => 0.2 });
  assert.equal(o.address_incomplete, 1);
  assert.equal(o.received_ts, `${DAY} 07:30`);
  assert.equal(o.cutoff_breach, 0);
  assert.equal(o.stock_miss, 1);
});

test('a held order gets only intake decisions and nothing throws', () => {
  const { model, capacity } = buildWorld(history(), S);
  const orders = [toAgentOrder(row(1, { status: 'held' }), opts), toAgentOrder(row(2), opts), toAgentOrder(row(3, { warehouse_id: null }), opts)];
  const ctx = { settings: S, model, distances, rates, limits: capacity.forDay(3).limits, stockPairs: new Set(['C1|West']), isFriday: isFriday(DAY), rand: randForDay(S.seed, DAY) };
  const { decided, decisions } = deskDecide(orders, ctx);
  const held = decisions.filter((d) => d.delivery_id === 'IN-000001');
  assert.ok(held.length > 0 && held.every((d) => d.agent === 'intake'));
  assert.equal(decided.some((o) => o.delivery_id === 'IN-000003'), false);
  assert.ok(decisions.some((d) => d.delivery_id === 'IN-000002'));
});

const o = { received_ts: '2026-09-23 09:15', nearest_warehouse_id: 'W1', gateway_carrier_id: 'D' };

test('wave effects', () => {
  assert.equal(effectsOf({ agent: 'wave', wave: 2, needsApproval: false }, o, 'auto').note, 'Second pick wave at 13:00: still same-day');
  assert.equal(effectsOf({ agent: 'wave', wave: 'next', needsApproval: true }, o, 'pending').note, 'Waiting for approval to join the second wave');
  assert.equal(effectsOf({ agent: 'wave', wave: 'next', needsApproval: true }, o, 'approved').note, 'Second pick wave at 13:00: still same-day');
  for (const a of ['rejected', 'expired']) {
    const e = effectsOf({ agent: 'wave', wave: 'next', needsApproval: true }, o, a);
    assert.equal(e.note, 'Second wave full: promised next-day');
    assert.deepEqual(e.fields, { commitment_type: 'next_day', promised_date: '2026-09-25' });
  }
});

test('intake effects', () => {
  const fix = effectsOf({ agent: 'intake', fixAddress: true, needsApproval: false }, o, 'auto');
  assert.deepEqual(fix, { fields: { release: true }, note: "Address completed from the client's records" });
  assert.equal(effectsOf({ agent: 'intake', fixAddress: false }, o, 'auto').note, 'Address query sent to the client');
});

test('stock effect', () => {
  assert.deepEqual(effectsOf({ agent: 'stock' }, o, 'auto'), { fields: { warehouse_id: 'W1' }, note: 'Stock moved to the nearest warehouse (W1)' });
});

test('carrier effects: a restricted order kept on the gateway carrier gets a confirmation note, no field changes', () => {
  const confirmed = { fields: {}, note: 'Carrier B confirmed: the most reliable within capacity on this lane' };
  const sameDay = { ...o, gateway_carrier_id: 'B', commitment_type: 'same_day', account_tier: 'Tier 2' };
  const tier1 = { ...o, gateway_carrier_id: 'B', commitment_type: 'standard', account_tier: 'Tier 1' };
  assert.deepEqual(effectsOf({ agent: 'carrier', carrier_id: 'B' }, sameDay, 'auto'), confirmed);
  assert.deepEqual(effectsOf({ agent: 'carrier', carrier_id: 'B' }, tier1, 'approved'), confirmed);
  assert.equal(effectsOf({ agent: 'carrier', carrier_id: 'B' }, { ...tier1, account_tier: 'Tier 2' }, 'auto'), null);
});

test('carrier effects', () => {
  assert.equal(effectsOf({ agent: 'carrier', carrier_id: 'D' }, o, 'auto'), null);
  assert.deepEqual(effectsOf({ agent: 'carrier', carrier_id: 'A' }, o, 'auto'), { fields: { carrier_id: 'A' }, note: 'Carrier A chosen: more reliable on this lane' });
  assert.equal(effectsOf({ agent: 'carrier', carrier_id: 'A', needsApproval: true, fallbackCarrierId: 'B' }, o, 'pending').note, 'Carrier A waiting for approval (over the cost limit)');
  assert.equal(effectsOf({ agent: 'carrier', carrier_id: 'A', needsApproval: true, fallbackCarrierId: 'B' }, o, 'rejected').fields.carrier_id, 'B');
});

test('watchtower effects', () => {
  const up = effectsOf({ agent: 'watchtower', action: 'upgrade', carrier_id: 'A', notifyClient: false }, o, 'auto');
  assert.deepEqual(up, { fields: { carrier_id: 'A' }, note: 'Moved to carrier A before the 14:00 collection' });
  const tell = effectsOf({ agent: 'watchtower', action: 'none', notifyClient: true, needsApproval: true }, o, 'approved');
  assert.deepEqual(tell, { fields: {}, note: 'Client told about the risk of a late delivery' });
  assert.equal(effectsOf({ agent: 'watchtower', action: 'none', notifyClient: true, needsApproval: true }, o, 'pending'), null);
});
