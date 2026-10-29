import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMime } from '../src/ingest/channels/mime.js';
import { parseCsv } from '../src/ingest/channels/csv.js';
import { emailToRecords } from '../src/ingest/channels/email.js';
import { parseX12 } from '../src/ingest/channels/edi.js';
import { normalizeOrder } from '../src/ingest/normalize.js';
import { validateOrder } from '../src/ingest/validate.js';
import { signToken, verifyToken, hashSecret, checkSecret } from '../src/ingest/auth.js';

const CRLF = (s) => s.replace(/\n/g, '\r\n');

test('MIME: decodes quoted-printable body and a base64 CSV attachment', () => {
  const csv = Buffer.from('po,sku,qty,service,name,street,city,state,zip\nPO-1,HX-1,5,next day,Al B,1 Main St,Hartford,CT,06103\n').toString('base64');
  const eml = CRLF(`From: Orders <orders@client055.example>
Subject: =?UTF-8?Q?PO_batch?=
Date: Tue, 27 Oct 2026 07:15:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hi team, see attached =E2=80=94 thanks
--b1
Content-Type: text/csv; name="orders.csv"
Content-Disposition: attachment; filename="orders.csv"
Content-Transfer-Encoding: base64

${csv}
--b1--
`);
  const m = parseMime(eml);
  assert.equal(m.headers.subject, 'PO batch');
  assert.equal(m.from, 'orders@client055.example');
  assert.match(m.text, /see attached — thanks/);
  assert.equal(m.attachments.length, 1);
  assert.match(m.attachments[0].content, /PO-1,HX-1/);
});

test('CSV: quoted fields and header synonyms', () => {
  const rows = parseCsv('"PO Number",Quantity,"Ship To Name"\n"PO-9",3,"Smith, Jo"\n');
  assert.deepEqual(rows, [{ 'PO Number': 'PO-9', Quantity: '3', 'Ship To Name': 'Smith, Jo' }]);
});

test('email: body with two orders split by a separator, client from sender domain', () => {
  const recs = emailToRecords({
    from: 'buyer@client190.example', subject: 'Orders', date: '2026-10-27T07:30',
    text: 'SKU: HX-1 Qty: 2\nShip to: A\nAddress: 1 Main St\nCity: Atlanta\nState: GA\nZIP: 30309\n---\nSKU: HX-2 Qty: 3\nShip to: B\nAddress: 2 Main St\nCity: Atlanta\nState: GA\nZIP: 30309',
    attachments: [],
  });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].client_hint, 'C190');
  assert.equal(recs[1].sku, 'HX-2');
});

test('EDI X12 850: two transaction sets become two orders; bad SE count is reported', () => {
  const x12 = 'ISA*00*          *00*          *ZZ*C055           *ZZ*HALCYON        *261027*0715*U*00401*000000001*0*P*>~GS*PO*C055*HALCYON*20261027*0715*1*X*004010~'
    + 'ST*850*0001~BEG*00*SA*PO-77**20261027~TD5*****NEXT DAY~N1*ST*Dana Ortiz~N3*418 Harbor Street~N4*Hartford*CT*06103~PO1*1*40*EA***VP*HX-2201~SE*8*0001~'
    + 'ST*850*0002~BEG*00*SA*PO-78**20261027~N1*ST*Sam~N3*77 Oak Ave~N4*Columbus*OH*43215~PO1*1*5*EA***VP*HX-9~SE*99*0002~GE*2*1~IEA*1*000000001~';
  const r = parseX12(x12);
  assert.equal(r.sender, 'C055');
  assert.equal(r.orders.length, 2);
  assert.equal(r.orders[0].client_order_ref, 'PO-77');
  assert.equal(r.orders[0].service, 'NEXT DAY');
  assert.equal(r.orders[0].ship_to.zip, '06103');
  assert.deepEqual(r.orders[1].structural_errors, ['SE segment count 99 does not match 7 segments']);
});

test('normalise: fixes state names, lost ZIP zeros, ZIP+4, service synonyms, quantities and casing', () => {
  const { order, corrections } = normalizeOrder({
    client_hint: 'c55', sku: ' hx 2201 ', quantity: '40 units', service: 'Overnight',
    ship_to: { name: ' dana  ortiz ', street: '418 harbor street', city: 'HARTFORD', state: 'Connecticut', zip: '6103' },
  });
  assert.equal(order.client_id, 'C055');
  assert.equal(order.sku, 'HX-2201');
  assert.equal(order.quantity, 40);
  assert.equal(order.commitment_type, 'next_day');
  assert.deepEqual(order.ship_to, { name: 'Dana Ortiz', street: '418 Harbor Street', city: 'Hartford', state: 'CT', zip: '06103' });
  const fixed = corrections.map((c) => c.field);
  for (const f of ['client_id', 'sku', 'quantity', 'commitment_type', 'ship_to.state', 'ship_to.zip']) assert.ok(fixed.includes(f), f);
  assert.equal(normalizeOrder({ ship_to: { zip: '06103-4410', state: 'CT' } }).order.ship_to.zip, '06103');
});

test('validate: hold for fixable problems, reject when the order cannot be attributed', () => {
  const clients = new Map([['C055', { client_id: 'C055' }]]);
  const base = { client_id: 'C055', sku: 'HX-1', quantity: 2, commitment_type: 'standard',
    ship_to: { name: 'A', street: '1 Main St', city: 'Hartford', state: 'CT', zip: '06103' } };
  assert.equal(validateOrder(base, { clients }).decision, 'accept');
  const held = validateOrder({ ...base, quantity: 0, ship_to: { ...base.ship_to, zip: '94105' } }, { clients });
  assert.equal(held.decision, 'hold');
  assert.deepEqual(held.issues.map((i) => i.code).sort(), ['invalid_quantity', 'zip_state_mismatch']);
  assert.ok(held.issues.find((i) => i.code === 'zip_state_mismatch').suggestion);
  assert.equal(validateOrder({ ...base, client_id: 'C999' }, { clients }).decision, 'reject');
});

test('auth: scrypt secrets and HS256 tokens with expiry', () => {
  const h = hashSecret('s3cret');
  assert.ok(checkSecret('s3cret', h));
  assert.ok(!checkSecret('wrong', h));
  const t = signToken({ sub: 'C055' }, 'key', 60);
  assert.equal(verifyToken(t, 'key').sub, 'C055');
  assert.equal(verifyToken(t, 'other'), null);
  assert.equal(verifyToken(signToken({ sub: 'C055' }, 'key', -1), 'key'), null);
});

test('email: quoted history in a forward is ignored, so an old order is not read twice', () => {
  const recs = emailToRecords({ from: 'orders@client055.example', subject: 'FW: order', date: '2026-10-27T07:30', attachments: [],
    text: 'Please ship this one too.\nPO: NEW-1\nSKU: HX-1 Qty: 2\nShip to: A B\nAddress: 1 Main St\nCity: Hartford\nState: CT\nZIP: 06103\n\nOn Mon, 26 Oct 2026, Dana wrote:\n> PO: OLD-1\n> SKU: HX-9 Qty: 5\n> Ship to: C D' });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].client_order_ref, 'NEW-1');
});

test('EDI: received time comes from the GS envelope', () => {
  const r = parseX12('ISA*00*          *00*          *ZZ*C055           *ZZ*HALCYON        *261027*0715*U*00401*000000001*0*P*>~GS*PO*C055*HALCYON*20261027*0912*1*X*004010~ST*850*0001~BEG*00*SA*PO-1**20261027~N1*ST*A~N3*1 Main St~N4*Hartford*CT*06103~PO1*1*1*EA***VP*HX-1~SE*7*0001~GE*1*1~IEA*1*000000001~');
  assert.equal(r.orders[0].received_ts, '2026-10-27T09:12');
});

test('email: an empty labelled field does not swallow the next line', () => {
  const [r] = emailToRecords({ from: 'orders@client055.example', subject: 'x', date: '2026-10-27T07:00', attachments: [],
    text: 'Account: C055\nPO: P-1\nSKU: HX-1 Qty: 2\nShip to: A B\nAddress: 1 Main St\nCity: \nState: CT\nZIP: 06103' });
  assert.equal(r.ship_to.city, '');
  assert.equal(r.ship_to.state, 'CT');
});

test('email: a client id inside a PO number is not taken as the client', () => {
  const [r] = emailToRecords({ from: 'orders@unknown-co.example', subject: 'Order', date: '2026-10-27T07:00', attachments: [],
    text: 'PO: LW-C171-1094\nSKU: HX-1 Qty: 2\nShip to: A B\nAddress: 1 Main St\nCity: Hartford\nState: CT\nZIP: 06103' });
  assert.equal(r.client_hint, '');
});

test('email: PO number recognised under its common labels', () => {
  for (const label of ['PO', 'PO Number', 'P.O.', 'Purchase order', 'Order ref', 'Order number']) {
    const [r] = emailToRecords({ from: 'orders@client055.example', subject: 'x', date: '2026-10-27T07:00', attachments: [],
      text: `${label}: AB-123\nSKU: HX-1 Qty: 2\nShip to: A B\nAddress: 1 Main St\nCity: Hartford\nState: CT\nZIP: 06103` });
    assert.equal(r.client_order_ref, 'AB-123', label);
  }
});

test('validate: ZIP checked against the state\'s 3-digit ranges, not just the first digit', () => {
  const clients = new Map([['C055', {}]]);
  const base = { client_id: 'C055', sku: 'HX-1', quantity: 1, commitment_type: 'standard', ship_to: { name: 'A', street: '1 Main St', city: 'Baltimore', state: 'MD', zip: '21202' } };
  assert.equal(validateOrder(base, { clients }).decision, 'accept');
  const vaZipInMd = validateOrder({ ...base, ship_to: { ...base.ship_to, zip: '23219' } }, { clients });   // same first digit, wrong state
  assert.deepEqual(vaZipInMd.issues.map((i) => i.code), ['zip_state_mismatch']);
  assert.match(vaZipInMd.issues[0].suggestion, /VA/);
});

test('email: an account named once at the top applies to every order in the email', () => {
  const recs = emailToRecords({ from: 'buyer@client124.example', subject: '2 orders', date: '2026-10-29T07:21', attachments: [],
    text: 'Account: C662\nPO: A-1\nSKU: HX-1 Qty: 2\nShip to: A\nAddress: 1 Main St\nCity: Boise\nState: ID\nZIP: 83702\n---\nPO: A-2\nSKU: HX-2 Qty: 3\nShip to: B\nAddress: 2 Main St\nCity: Boise\nState: ID\nZIP: 83702' });
  assert.deepEqual(recs.map((r) => r.client_hint), ['C662', 'C662']);
});

// ---- gateway: cutoff deferral, forced client and time ----
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { IngestService } from '../src/ingest/IngestService.js';

function makeGateway({ deferCutoff, clock } = {}) {
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
    distances: { W1: { NE: 100 } },
    anomalies: { inspect: () => ({ findings: [] }) },
    capacity: { forDay: () => ({ reserve() {} }) },
    nextBestAction: { decide: () => ({ best: { carrier_id: 'K1' } }) },
    scorer: { score: () => ({ risk: 0, drivers: [] }) },
    avgDailyOrders: 10,
    stockMiss: () => 0,
  };
  const clients = new Map([['C001', {}], ['C055', {}]]);
  const service = new IngestService(new IngestPipeline({ repo, clients, ai, deferCutoff }), null, { clock });
  return { service, saved };
}

const apiOrder = { client_order_ref: 'P1', sku: 'HX-1', quantity: 2, service: 'same_day', received_at: '2026-09-25 09:15',
  ship_to: { name: 'A', street: '1 Main St', city: 'Hartford', state: 'CT', zip: '06103' } };

test('gateway: deferCutoff keeps a late same-day order same-day and notes it for the Wave Planner', async () => {
  const { service } = makeGateway({ deferCutoff: true });
  const [o] = (await service.api('C001', [apiOrder])).orders;
  assert.notEqual(o.status, 'corrected');
  assert.equal(o.commitment_type, 'same_day');
  const issue = o.issues.find((i) => i.code === 'same_day_after_cutoff');
  assert.equal(issue.severity, 'info');
  assert.match(issue.message, /Received 09:15, after the 08:00 pick-list cutoff: the Wave Planner decides/);
  assert.equal(o.promised_date, '2026-09-25');
});

test('gateway: the carrier it chose is kept on the order as gateway_carrier_id', async () => {
  const { service, saved } = makeGateway();
  await service.api('C001', [apiOrder]);
  assert.equal(saved[0].carrier_id, 'K1');
  assert.equal(saved[0].normalized.gateway_carrier_id, 'K1');
});

test('gateway: without deferCutoff a late same-day order is re-promised next-day', async () => {
  const { service } = makeGateway({ deferCutoff: false });
  const [o] = (await service.api('C001', [apiOrder])).orders;
  assert.equal(o.status, 'corrected');
  assert.equal(o.commitment_type, 'next_day');
});

test('gateway: clock supplies the time for API orders without their own', async () => {
  const { service, saved } = makeGateway({ clock: () => '2026-09-25 07:00' });
  await service.api('C001', [{ ...apiOrder, received_at: undefined }]);
  assert.equal(saved[0].normalized.received_ts.slice(0, 16).replace('T', ' '), '2026-09-25 07:00');
});

test('gateway: forced client and time override an EDI sender', async () => {
  const pad = (s, n) => s.padEnd(n);
  const isa = `ISA*00*${pad('', 10)}*00*${pad('', 10)}*ZZ*${pad('C001', 15)}*ZZ*${pad('HALCYON', 15)}*260925*0715*U*00401*000000001*0*P*>`;
  const edi = [isa, 'GS*PO*C001*HALCYON*20260925*0715*1*X*004010', 'ST*850*0001', 'BEG*00*SA*PO-9**20260925',
    'TD5*****Same Day', 'N1*ST*Ann', 'N3*1 Main St', 'N4*Hartford*CT*06103', 'PO1*1*2*EA*1.00**VP*HX-1', 'SE*9*0001', 'GE*1*1', 'IEA*1*000000001', ''].join('~');
  const { service, saved } = makeGateway();
  await service.edi(edi, { filename: 'a.edi' }, { client_id: 'C055', received_ts: '2026-09-25 10:30' });
  assert.ok(saved.length);
  for (const o of saved) {
    assert.equal(o.client_id, 'C055');
    assert.equal(o.normalized.received_ts.slice(0, 16).replace('T', ' '), '2026-09-25 10:30');
  }
});

test('gateway: forced client overrides an email sender', async () => {
  const { service, saved } = makeGateway();
  const raw = 'From: orders@client001.example\r\nSubject: Order\r\nDate: Fri, 25 Sep 2026 07:15:00 +0000\r\n\r\n'
    + 'PO: AB-123\nSKU: HX-1 Qty: 2\nShip to: A B\nAddress: 1 Main St\nCity: Hartford\nState: CT\nZIP: 06103\n';
  await service.email(raw, {}, { client_id: 'C055', received_ts: '2026-09-25 10:30' });
  assert.ok(saved.length);
  for (const o of saved) assert.equal(o.client_id, 'C055');
});

// ---- channel label: the portal form is shown as 'Portal form', scored as the history's 'API' ----
import { modelChannel, RISK_FEATURES } from '../src/ml/features.js';

function spyGateway() {
  const seen = { messages: [], inspected: [], scored: [], saved: [] };
  const repo = {
    createMessage: async (m) => { seen.messages.push(m); return { id: 1 }; },
    saveOrder: async (o) => { seen.saved.push(o); return { id: seen.saved.length }; },
    finishMessage: async () => {},
    findLiveOrder: async () => null,
    otherClientsUsingRef: async () => [],
    carrierUsage: async () => ({}),
  };
  const ai = {
    distances: { W1: { NE: 100 } },
    anomalies: { inspect: (o) => { seen.inspected.push(o); return { findings: [] }; } },
    capacity: { forDay: () => ({ reserve() {} }) },
    nextBestAction: { decide: () => ({ best: { carrier_id: 'K1' } }) },
    scorer: { score: (f) => { seen.scored.push(f); return { risk: 0, drivers: [] }; } },
    avgDailyOrders: 10,
    stockMiss: () => 0,
  };
  return { service: new IngestService(new IngestPipeline({ repo, clients: new Map([['C001', {}]]), ai })), seen };
}

test('channel: the history knows API, EDI and Email only; the portal form is scored as API', () => {
  const known = RISK_FEATURES.find((f) => f.name === 'order_channel').values;
  assert.deepEqual(known, ['API', 'EDI', 'Email']);
  assert.equal(modelChannel('Portal form'), 'API');
  for (const c of known) assert.equal(modelChannel(c), c);
});

test('gateway: a portal form order is labelled Portal form, while the model and anomaly screen see API', async () => {
  const { service, seen } = spyGateway();
  const { orders } = await service.form('C001', apiOrder);
  assert.equal(orders.length, 1);
  assert.equal(seen.messages[0].channel, 'Portal form');
  assert.equal(seen.saved[0].normalized.channel, 'Portal form');
  assert.equal(seen.inspected[0].order_channel, 'API');
  assert.equal(seen.scored[0].order_channel, 'API');
});

test('gateway: a /v1 API client order stays API', async () => {
  const { service, seen } = spyGateway();
  await service.api('C001', [apiOrder]);
  assert.equal(seen.messages[0].channel, 'API');
  assert.equal(seen.saved[0].normalized.channel, 'API');
  assert.equal(seen.scored[0].order_channel, 'API');
});
