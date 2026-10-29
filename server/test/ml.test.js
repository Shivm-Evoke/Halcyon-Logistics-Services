import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureEncoder } from '../src/ml/FeatureEncoder.js';
import { LogisticRegression } from '../src/ml/LogisticRegression.js';
import { auc, classification, calibration } from '../src/ml/metrics.js';
import { RiskModel } from '../src/ml/RiskModel.js';
import { NextBestAction } from '../src/ml/NextBestAction.js';
import { ClientProfiler } from '../src/quality/ClientProfiler.js';

const SPEC = [
  { name: 'carrier', type: 'categorical', values: ['A', 'D'] },
  { name: 'address_incomplete', type: 'binary' },
  { name: 'miles', type: 'numeric', transform: 'log1p' },
];

// Deterministic pseudo-random generator so tests are repeatable.
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

function synthetic(n, seed = 7) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const row = { carrier: r() < 0.5 ? 'A' : 'D', address_incomplete: r() < 0.2 ? 1 : 0, miles: 50 + r() * 2000 };
    const z = -2.5 + (row.carrier === 'D' ? 1.8 : 0) + 2.2 * row.address_incomplete + 0.4 * Math.log1p(row.miles) - 2.4;
    return { ...row, late: r() < 1 / (1 + Math.exp(-z)) ? 1 : 0 };
  });
}

test('encoder one-hots categoricals, keeps binaries, standardises numerics', () => {
  const enc = new FeatureEncoder(SPEC).fit(synthetic(200));
  assert.deepEqual(enc.columns, ['carrier=A', 'carrier=D', 'address_incomplete', 'miles']);
  const x = enc.encode({ carrier: 'D', address_incomplete: 1, miles: 100 });
  assert.equal(x[0], 0); assert.equal(x[1], 1); assert.equal(x[2], 1);
  assert.ok(Number.isFinite(x[3]));
  // Unknown category and missing numeric fall back to zeros / the training mean.
  const y = enc.encode({ carrier: 'Z' });
  assert.deepEqual([y[0], y[1], y[3]], [0, 0, 0]);
});

test('logistic regression recovers the signal and converges', () => {
  const rows = synthetic(4000);
  const enc = new FeatureEncoder(SPEC).fit(rows);
  const lr = new LogisticRegression({ l2: 1 }).fit(rows.map((r) => enc.encode(r)), rows.map((r) => r.late));
  const [a, d, addr] = lr.weights;
  assert.ok(d - a > 1.2, `carrier D should raise risk (got ${d - a})`);
  assert.ok(addr > 1.5, `incomplete address should raise risk (got ${addr})`);
  assert.ok(lr.iterations < 25);
});

test('metrics: AUC, classification and calibration', () => {
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);
  const c = classification([0.9, 0.6, 0.4, 0.1], [1, 0, 1, 0], 0.5);
  assert.deepEqual([c.tp, c.fp, c.fn, c.tn], [1, 1, 1, 1]);
  assert.equal(calibration([0.05, 0.15, 0.95], [0, 0, 1], 10).length, 3);
});

test('risk model scores in microseconds and explains its drivers', () => {
  const model = new RiskModel(SPEC, { l2: 1 }).fit(synthetic(3000));
  const s = model.score({ carrier: 'D', address_incomplete: 1, miles: 1800 });
  assert.ok(s.risk > 0.5);
  assert.equal(s.drivers[0].feature, 'address_incomplete');
  assert.ok(s.drivers[0].impact > 0);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) model.risk({ carrier: 'A', address_incomplete: 0, miles: 100 });
  const usPerScore = Number(process.hrtime.bigint() - t0) / 1000 / 20000;
  assert.ok(usPerScore < 50, `scoring took ${usPerScore.toFixed(2)}µs`);
  const copy = RiskModel.fromJSON(JSON.parse(JSON.stringify(model.toJSON())));
  assert.equal(copy.risk({ carrier: 'D', address_incomplete: 1, miles: 1800 }), s.risk);
});

test('next best action picks the cheapest expected cost, not the cheapest rate', () => {
  const scorer = { risk: (o) => (o.carrier_id === 'D' ? 0.4 : 0.05) };
  const nba = new NextBestAction(scorer, { carriers: [{ carrier_id: 'A', avg_rate: 16 }, { carrier_id: 'D', avg_rate: 13 }] });
  const best = nba.decide({ carrier_id: 'D', commitment_type: 'standard', sla: 1 }).best;
  assert.equal(best.carrier_id, 'A');
});

test('client profiler flags an unusual destination and duplicate order id', () => {
  const history = Array.from({ length: 200 }, (_, i) => ({
    client_id: 'C1', order_id: `O${i}`, order_channel: 'EDI', destination_region: 'West', commitment_type: 'standard', received_hour: 9,
  }));
  const p = new ClientProfiler().fit(history);
  const findings = p.inspect({ client_id: 'C1', order_id: 'O5', order_channel: 'EDI', destination_region: 'Northeast', commitment_type: 'standard', received_hour: 9 }, { otherClientOrderIds: new Set(['O5']) });
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('unusual_destination'));
  assert.ok(codes.includes('duplicate_order_id'));
  assert.ok(!codes.includes('unusual_channel'));
});

test('client profiler skips a rarity check when the value is unknown, so no "null" reaches the message', () => {
  const history = Array.from({ length: 200 }, (_, i) => ({
    client_id: 'C1', order_id: `O${i}`, order_channel: 'EDI', destination_region: 'West', commitment_type: 'standard', received_hour: 9,
  }));
  const findings = new ClientProfiler().fit(history)
    .inspect({ client_id: 'C1', order_id: 'X1', order_channel: null, destination_region: null, commitment_type: undefined, received_hour: null });
  assert.deepEqual(findings.filter((f) => /null|undefined|NaN/.test(f.message)), []);
  assert.ok(!findings.some((f) => f.code === 'unusual_destination'));
});

test('data-quality scanner counts and samples each check through an injected query', async () => {
  const { DataQualityScanner } = await import('../src/quality/DataQualityScanner.js');
  const calls = [];
  const fakeQuery = async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT count(*)')) return [{ n: sql.includes('bad') ? 2 : 0 }];
    return [{ ref: 'D1', detail: 'x' }, { ref: 'D2', detail: 'y' }];
  };
  const scanner = new DataQualityScanner(fakeQuery, [
    { id: 'bad', severity: 'high', title: 'Bad', why: '', source: 'test', sql: 'SELECT 1 AS bad' },
    { id: 'good', severity: 'low', title: 'Good', why: '', source: 'test', sql: 'SELECT 1' },
  ]);
  const result = await scanner.scan();
  assert.deepEqual(result.checks.map((c) => [c.id, c.count, c.samples.length]), [['bad', 2, 2], ['good', 0, 0]]);
  assert.ok(!('sql' in result.checks[0]), 'SQL is not exposed to clients');
  const before = calls.length;
  await scanner.scan();
  assert.equal(calls.length, before, 'second scan is served from cache');
});
