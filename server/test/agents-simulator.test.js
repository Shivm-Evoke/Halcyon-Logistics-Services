import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReplay } from '../src/agents/simulator.js';
import { DEFAULT_SETTINGS } from '../src/agents/settings.js';

// Three days of orders on a good carrier (A) and a poor one (D), with every kind of problem the agents fix.
const distances = { W1: { West: 100 }, W2: { West: 1200 } };
const rates = { A: 15, D: 12 };
function fixture() {
  const rows = [];
  let id = 0;
  for (const day of ['2026-09-21', '2026-09-22', '2026-09-23']) {
    for (let i = 0; i < 80; i++) {
      const hour = i % 20;
      const carrier = i % 3 === 0 ? 'A' : 'D';
      const sameDay = i % 4 === 0;
      const after8 = hour >= 8;
      const incomplete = i % 7 === 0 ? 1 : 0;
      const miss = i % 9 === 0 ? 1 : 0;
      const cutoff = sameDay && after8 ? 1 : 0;
      const bad = (carrier === 'D' ? 1 : 0) + incomplete + miss + cutoff;
      rows.push({
        delivery_id: `D${++id}`, client_id: `C${i % 5}`, client_name: `Client ${i % 5}`, destination_region: 'West',
        received_ts: `${day} ${String(hour).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
        commitment_type: sameDay ? 'same_day' : 'standard', cutoff_breach: cutoff, address_incomplete: incomplete,
        stock_miss: miss, nearest_warehouse_id: 'W1', fulfilment_warehouse_id: miss ? 'W2' : 'W1',
        distance_miles: miss ? 1200 : 100, carrier_id: carrier, carrier_rate_usd: rates[carrier],
        account_tier: i % 11 === 0 ? 'Tier 1' : 'Tier 2', sla: i % 2, account_status: i % 5 === 4 ? 'threatening_to_leave' : 'active',
        late: (bad >= 2 || (bad === 1 && i % 2 === 0)) ? 1 : 0,
      });
    }
  }
  return rows;
}
const opts = (settings = DEFAULT_SETTINGS) => ({ settings, distances, rates, csComplaintHoursPerWeek: 461 });
const off = { ...DEFAULT_SETTINGS, agents: { intake: false, wave: false, carrier: false, stock: false, watchtower: false } };

test('with every agent off the replay reproduces the outcome model on the recorded decisions', () => {
  const r = runReplay(fixture(), opts(off));
  assert.equal(r.overall.agents, r.waterfall[0].onTime);
  assert.ok(Math.abs(r.overall.agents - r.overall.actual) < 0.05);
});

test('the agents lift on-time above the recorded rate', () => {
  const r = runReplay(fixture(), opts());
  assert.ok(r.overall.agents > r.overall.actual + 0.1, JSON.stringify(r.overall));
});

test('the same settings give the same result', () => {
  assert.deepEqual(runReplay(fixture(), opts()), runReplay(fixture(), opts()));
});

test('the waterfall runs baseline, intake, wave, stock, carrier, watchtower and ends at the overall rate', () => {
  const r = runReplay(fixture(), opts());
  assert.deepEqual(r.waterfall.map((w) => w.agent), ['baseline', 'intake', 'wave', 'stock', 'carrier', 'watchtower']);
  assert.equal(r.waterfall.at(-1).onTime, r.overall.agents);
});

test('money, weekly and at-risk accounts are reported', () => {
  const r = runReplay(fixture(), opts());
  assert.equal(r.weekly.length, 1);
  assert.ok(r.money.penaltiesSavedUsd > 0 && Number.isFinite(r.money.netUsd));
  assert.ok(r.accounts.length > 0 && r.accounts.every((a) => a.agents >= 0 && a.agents <= 1));
});

test('no orders gives nulls, never NaN', () => {
  const r = runReplay([], opts());
  assert.equal(r.overall.actual, null);
  assert.equal(r.overall.agents, null);
  assert.deepEqual(r.weekly, []);
  assert.ok(!JSON.stringify(r).includes('NaN'));
});
