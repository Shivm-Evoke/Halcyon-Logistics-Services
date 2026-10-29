import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IngestPipeline } from '../src/ingest/pipeline.js';

// The pipeline with its AI layer stubbed out: only the promise and the second-wave ledger are under test.
function pipeline({ wave2Used = 0 } = {}) {
  const repo = {
    findLiveOrder: async () => null,
    otherClientsUsingRef: async () => [],
    carrierUsage: async () => ({}),
    wave2Usage: async () => wave2Used,
  };
  const clients = new Map([['C190', { client_id: 'C190', account_tier: 'Tier 1', sla_penalty_clause: 'Y' }]]);
  const ai = {
    distances: { W3: { Southeast: 140, Midwest: 700 }, W2: { Southeast: 600, Midwest: 100 } },
    anomalies: { inspect: () => ({ findings: [] }) },
    stockMiss: () => 0,
    avgDailyOrders: 270,
    capacity: { forDay: () => ({ reserve() {}, hasRoom: () => true }) },
    nextBestAction: { decide: () => ({ best: { carrier_id: 'B' } }) },
    scorer: { score: () => ({ risk: 0.1, drivers: [] }) },
  };
  return new IngestPipeline({ repo, clients, ai });
}

const record = (over = {}) => ({
  client_hint: 'C190', client_order_ref: `PO-${Math.random()}`, sku: 'HX-2201', quantity: '5', service: 'same day',
  received_ts: '2026-10-27T10:15',
  ship_to: { name: 'Sam Lee', street: '12 Peachtree Road', city: 'Atlanta', state: 'GA', zip: '30303' },
  ...over,
});
const assess = (p, rec) => p.assess(rec, { channel: 'API', ledgers: new Map(), seen: new Set() });

test('a same-day order at 10:15 keeps same-day on the 13:00 second wave when the warehouse has room', async () => {
  const r = await assess(pipeline(), record());
  assert.equal(r.commitment_type, 'same_day');
  assert.equal(r.normalized.wave, 2);
  assert.equal(r.warehouse_id, 'W3');
  assert.ok(r.issues.some((i) => i.code === 'second_wave'));
  assert.ok(!r.issues.some((i) => i.code === 'same_day_after_cutoff'));
});

test('a same-day order at 10:15 is re-promised next-day when the second wave is full', async () => {
  const r = await assess(pipeline({ wave2Used: 30 }), record());
  assert.equal(r.commitment_type, 'next_day');
  assert.equal(r.normalized.wave, 'next');
  assert.ok(r.issues.some((i) => i.code === 'same_day_after_cutoff'));
});
