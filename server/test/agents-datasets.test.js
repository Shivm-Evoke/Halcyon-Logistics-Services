import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDataset, REQUIRED_COLUMNS } from '../src/agents/datasets.js';

const clients = new Map([
  ['C001', { client_name: 'Client 001', account_tier: 'Tier 1', sla_penalty_clause: 'Y', account_status: 'threatening_to_leave' }],
  ['C002', { client_name: 'Client 002', account_tier: 'Tier 3', sla_penalty_clause: 'N', account_status: 'active' }],
]);
const header = 'delivery_id,client_id,order_channel,order_received_ts,commitment_type,address_status,destination_region,nearest_warehouse_id,fulfilment_warehouse_id,nearest_warehouse_had_stock,distance_miles,carrier_id,carrier_rate_usd,on_time';
const csv = (...rows) => [header, ...rows].join('\n');

test('a valid row becomes an order the agents can work on, with client details looked up', () => {
  const r = parseDataset(csv('T1,C001,Email,2026-11-02 09:15,same_day,incomplete,West,W5,W2,N,1180,D,12.5,N'), { clients });
  assert.equal(r.rejected.length, 0);
  const [o] = r.orders;
  assert.equal(o.delivery_id, 'T1');
  assert.equal(o.received_ts, '2026-11-02 09:15');
  assert.equal(o.cutoff_breach, 1);          // same-day received after 08:00
  assert.equal(o.address_incomplete, 1);
  assert.equal(o.stock_miss, 1);
  assert.equal(o.distance_miles, 1180);
  assert.equal(o.account_tier, 'Tier 1');
  assert.equal(o.sla, 1);
  assert.equal(o.account_status, 'threatening_to_leave');
  assert.equal(o.late, 1);
  assert.equal(r.hasOutcomes, true);
  assert.deepEqual(r.days, ['2026-11-02']);
});

test('stock miss means "shipped from another warehouse", the definition the model is trained on', () => {
  // Nearest W3 reports stock but the order still left from W2: a miss, as in the history (f_stock).
  const moved = parseDataset(csv('T2,C001,API,2026-11-02 07:15,standard,complete,Southeast,W3,W2,Y,600,B,15,Y'), { clients }).orders[0];
  assert.equal(moved.stock_miss, 1);
  // Shipped from the nearest warehouse: no miss, whatever the stock column says.
  const local = parseDataset(csv('T3,C001,API,2026-11-02 07:15,standard,complete,Southeast,W3,W3,N,140,B,15,Y'), { clients }).orders[0];
  assert.equal(local.stock_miss, 0);
});

test('outcomes are optional; optional columns get sensible defaults', () => {
  const r = parseDataset([
    'client_id,order_received_ts,commitment_type,address_status,destination_region,nearest_warehouse_id,nearest_warehouse_had_stock,distance_miles,carrier_id',
    'C002,2026-11-02T07:30:00,standard,complete,Midwest,W1,Y,120,B',
  ].join('\n'), { clients });
  const [o] = r.orders;
  assert.equal(r.rejected.length, 0);
  assert.equal(o.late, null);
  assert.equal(r.hasOutcomes, false);
  assert.equal(o.delivery_id, 'R2');              // made from the line number
  assert.equal(o.order_channel, 'API');
  assert.equal(o.fulfilment_warehouse_id, 'W1');
  assert.equal(o.received_ts, '2026-11-02 07:30');
  assert.equal(o.cutoff_breach, 0);
});

test('bad rows are listed with their line and reason; good rows are kept', () => {
  const r = parseDataset(csv(
    'T1,C001,Email,2026-11-02 09:15,same_day,complete,West,W5,W5,Y,90,A,15,Y',
    'T2,C999,Email,2026-11-02 09:15,same_day,complete,West,W5,W5,Y,90,A,15,Y',
    'T3,C001,Email,yesterday,same_day,complete,West,W5,W5,Y,90,A,15,Y',
    'T4,C001,Email,2026-11-02 09:15,express,complete,West,W5,W5,Y,90,A,15,Y',
    'T5,C001,Email,2026-11-02 09:15,same_day,complete,West,W5,W5,Y,90,Z,15,Y',
    'T6,C001,Email,2026-11-02 09:15,same_day,complete,West,W5,W5,Y,-4,A,15,Y',
    'T1,C001,Email,2026-11-02 09:15,same_day,complete,West,W5,W5,Y,90,A,15,Y',
  ), { clients });
  assert.equal(r.orders.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.line), [3, 4, 5, 6, 7, 8]);
  assert.match(r.rejected[0].reason, /client C999/i);
  assert.match(r.rejected[1].reason, /order_received_ts/);
  assert.match(r.rejected[2].reason, /commitment_type/);
  assert.match(r.rejected[3].reason, /carrier_id/);
  assert.match(r.rejected[4].reason, /distance_miles/);
  assert.match(r.rejected[5].reason, /duplicate/i);
});

test('a file missing a required column is refused as a whole, naming the column', () => {
  const r = parseDataset('client_id,order_received_ts\nC001,2026-11-02 09:00', { clients });
  assert.equal(r.orders.length, 0);
  assert.ok(r.error);
  assert.ok(r.missing.includes('commitment_type'));
  assert.deepEqual(REQUIRED_COLUMNS.filter((c) => r.missing.includes(c)), r.missing);
});

test('an empty file is refused', () => {
  assert.ok(parseDataset('', { clients }).error);
  assert.ok(parseDataset(header, { clients }).error);
});
