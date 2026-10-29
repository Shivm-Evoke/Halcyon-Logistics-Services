import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { IngestService } from '../src/ingest/IngestService.js';
import { checkSecret } from '../src/ingest/auth.js';
import { parseX12 } from '../src/ingest/channels/edi.js';
import { parseMime } from '../src/ingest/channels/mime.js';
import {
  SAMPLES, SAMPLES_DIR, forceFor, freshPo, sendSample, rotateApiKey, customerDecisions, formOrder,
} from '../src/portal/channels.js';

function makeGateway() {
  const saved = [];
  const repo = {
    createMessage: async () => ({ id: 1 }),
    saveOrder: async (o) => { saved.push(o); return { id: saved.length }; },
    finishMessage: async () => {},
    findLiveOrder: async () => null,
    otherClientsUsingRef: async () => [],
    carrierUsage: async () => ({}),
  };
  const ai = {
    distances: { W1: { Northeast: 100 } },
    anomalies: { inspect: () => ({ findings: [] }) },
    capacity: { forDay: () => ({ reserve() {} }) },
    nextBestAction: { decide: () => ({ best: { carrier_id: 'K1' } }) },
    scorer: { score: () => ({ risk: 0, drivers: [] }) },
    avgDailyOrders: 10,
    stockMiss: () => 0,
  };
  const clients = new Map([['C001', {}], ['C055', {}]]);
  return { service: new IngestService(new IngestPipeline({ repo, clients, ai }), null), saved };
}

const customer = { role: 'customer', client_id: 'C055' };

test('portal: forceFor takes the client from the session and the time from the ops clock', () => {
  assert.deepEqual(forceFor(customer, '2026-09-25 09:15'), { client_id: 'C055', received_ts: '2026-09-25 09:15' });
  assert.deepEqual(forceFor(customer, null), { client_id: 'C055', received_ts: undefined });
});

test('portal: EDI whose ISA sender is C001, posted by a C055 customer, is ordered for C055', async () => {
  const pad = (s, n) => s.padEnd(n);
  const isa = `ISA*00*${pad('', 10)}*00*${pad('', 10)}*ZZ*${pad('C001', 15)}*ZZ*${pad('HALCYON', 15)}*260925*0715*U*00401*000000001*0*P*>`;
  const edi = [isa, 'GS*PO*C001*HALCYON*20260925*0715*1*X*004010', 'ST*850*0001', 'BEG*00*SA*PO-9**20260925',
    'TD5*****Same Day', 'N1*ST*Ann', 'N3*1 Main St', 'N4*Hartford*CT*06103', 'PO1*1*2*EA*1.00**VP*HX-1', 'SE*9*0001', 'GE*1*1', 'IEA*1*000000001', ''].join('~');
  const { service, saved } = makeGateway();
  const { orders } = await service.edi(edi, { filename: 'po.edi' }, forceFor(customer, '2026-09-25 09:15'));
  assert.equal(orders.length, 1);
  assert.equal(saved[0].client_id, 'C055');
  assert.equal(saved[0].normalized.received_ts.slice(0, 16).replace('T', ' '), '2026-09-25 09:15');
});

test('portal: an unknown sample is not sent', async () => {
  const { service, saved } = makeGateway();
  assert.equal(await sendSample(service, '9', forceFor(customer, null)), null);
  assert.equal(await sendSample(service, 'constructor', forceFor(customer, null)), null);
  assert.equal(saved.length, 0);
});

test('portal: every sample reaches the gateway as one order of the customer\'s client, at the ops clock', async () => {
  for (const n of Object.keys(SAMPLES)) {
    const { service, saved } = makeGateway();
    const out = await sendSample(service, n, forceFor(customer, '2026-09-25 09:15'), { suffix: 'T1' });
    assert.equal(out.channel, SAMPLES[n].channel);
    assert.equal(saved.length, 1, `sample ${n}`);
    assert.equal(saved[0].client_id, 'C055', `sample ${n}`);
    assert.equal(saved[0].normalized.received_ts.slice(0, 16).replace('T', ' '), '2026-09-25 09:15', `sample ${n}`);
    assert.equal(saved[0].client_order_ref, `SAMPLE-${n}-T1`, `sample ${n}`);
  }
});

test('portal: the sample files carry no timestamps of their own', () => {
  const email = parseMime(fs.readFileSync(path.join(SAMPLES_DIR, SAMPLES[1].file), 'utf8'));
  assert.equal(email.date || '', '');
  const edi = parseX12(fs.readFileSync(path.join(SAMPLES_DIR, SAMPLES[2].file), 'utf8'));
  assert.equal(edi.orders[0].received_ts, undefined);
  for (const n of [3, 4, 5]) assert.doesNotMatch(fs.readFileSync(path.join(SAMPLES_DIR, SAMPLES[n].file), 'utf8'), /received_at|\d{4}-\d{2}-\d{2}/);
});

test('portal: freshPo makes sample POs unique and leaves other text alone', () => {
  assert.equal(freshPo('PO: SAMPLE-1\nSKU: HX-1', 'AB'), 'PO: SAMPLE-1-AB\nSKU: HX-1');
  assert.equal(freshPo('BEG*00*SA*SAMPLE-2**', 'AB'), 'BEG*00*SA*SAMPLE-2-AB**');
});

test('portal: formOrder keeps only the form\'s fields', () => {
  assert.deepEqual(formOrder({ sku: 'HX-1', quantity: 2, service: 'same_day', client_id: 'C001', ship_to: { name: 'A' } }),
    { client_order_ref: undefined, sku: 'HX-1', quantity: 2, service: 'same_day', requested_date: undefined, ship_to: { name: 'A' } });
});

test('portal: an API key is a secret the login accepts, and a new key invalidates the old one', async () => {
  const hashes = new Map();
  const store = { setApiSecret: async (id, hash) => { hashes.set(id, hash); } };
  const first = await rotateApiKey(store, 'C055');
  assert.deepEqual({ ...first, secret: undefined }, { client_id: 'C055', secret: undefined, token_url: '/api/auth/login', docs_url: '/api/docs' });
  assert.ok(first.secret.length >= 24);
  assert.notEqual(hashes.get('C055'), first.secret);           // stored hashed
  assert.ok(checkSecret(first.secret, hashes.get('C055')));
  const second = await rotateApiKey(store, 'C055');
  assert.notEqual(second.secret, first.secret);
  assert.ok(checkSecret(second.secret, hashes.get('C055')));
  assert.equal(checkSecret(first.secret, hashes.get('C055')), false);
});

test('portal: decisions show the plain reason, without ids, costs or approval state', () => {
  const order = { decisions: [
    { id: 7, agent: 'carrier', rule: 'Lowest expected cost among A, B and C (same-day or Tier 1); 7.20 above the cheapest carrier it may use, over the 6 cap',
      reason: 'Lowest expected cost among A, B and C (same-day or Tier 1); 7.20 above …', reason_source: 'rules only', approval: 'pending', at: '2026-09-25 09:15' },
    { id: 8, agent: 'watchtower', rule: 'Risk of being late 48%', reason: 'Claude says the stock is late, so we called you.', reason_source: 'claude', approval: 'pending', at: '2026-09-25 09:15' },
  ] };
  assert.deepEqual(customerDecisions(order), [
    { agent: 'carrier', text: 'Lowest expected cost among A, B and C (same-day or Tier 1)', at: '2026-09-25 09:15' },
    { agent: 'watchtower', text: 'Claude says the stock is late, so we called you.', at: '2026-09-25 09:15' },
  ]);
  assert.deepEqual(customerDecisions(undefined), []);
});
