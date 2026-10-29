// Generates the inbound test pack: emails (.eml), EDI 850 files, API payloads and a client CSV drop,
// each exercising one or more real-world data problems. expected.json records the intended outcome
// of every order, which run-test-pack.mjs checks against the live system.
//   node ingest/generate-test-data.mjs
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'test-data');
const expected = {};
const write = (dir, name, content, outcome) => {
  fs.mkdirSync(path.join(OUT, dir), { recursive: true });
  fs.writeFileSync(path.join(OUT, dir, name), content);
  expected[`${dir}/${name}`] = outcome;
};
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');

function eml({ from, subject, time = '07:15', body, html, attachments = [], encoding }) {
  const headers = `From: ${from}\nTo: orders@halcyon.example\nSubject: ${subject}\nDate: Tue, 27 Oct 2026 ${time}:00 +0000\nMIME-Version: 1.0\n`;
  if (!attachments.length && !html) {
    const enc = encoding === 'base64' ? b64(body) : body;
    return crlf(`${headers}Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: ${encoding || '7bit'}\n\n${enc}\n`);
  }
  if (html && !attachments.length) return crlf(`${headers}Content-Type: text/html; charset=utf-8\n\n${html}\n`);
  const parts = [`--b1\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`,
    ...attachments.map((a) => `--b1\nContent-Type: text/csv; name="${a.name}"\nContent-Disposition: attachment; filename="${a.name}"\nContent-Transfer-Encoding: 7bit\n\n${a.content}\n`)];
  return crlf(`${headers}Content-Type: multipart/mixed; boundary="b1"\n\n${parts.join('')}--b1--\n`);
}

const addr = (o) => `Ship to: ${o.name}\nAddress: ${o.street}\nCity: ${o.city}\nState: ${o.state}\nZIP: ${o.zip}`;
const HARTFORD = { name: 'Dana Ortiz', street: '418 Harbor Street', city: 'Hartford', state: 'CT', zip: '06103' };
const ATLANTA = { name: 'Priya Natarajan', street: '2200 Peachtree Road', city: 'Atlanta', state: 'GA', zip: '30309' };

// ---------- Email ----------
write('email', '01-clean-order.eml', eml({ from: 'Orders <orders@client055.example>', subject: 'PO TP-E01',
  body: `Hi team,\nAccount: C055\nPO: TP-E01\nSKU: HX-2201   Qty: 40\nService: next day\n${addr(HARTFORD)}\nThanks` }),
[{ status: 'accepted' }]);

write('email', '02-missing-city-and-house-number.eml', eml({ from: 'orders@client055.example', subject: 'Order TP-E02',
  body: 'Customer C055, PO TP-E02 — please ship SKU HX-2201, qty 40, next day.\nShip to: Dana Ortiz\nAddress: Harbor Street\nState: CT\nZIP: 06103' }),
[{ status: 'held', codes: ['missing_house_number', 'missing_city'] }]);

write('email', '03-zip-in-wrong-state.eml', eml({ from: 'buyer@client263.example', subject: 'PO TP-E03',
  body: 'Client: C263\nPO TP-E03\nItem HX-118 x 15, standard delivery\nDeliver to: Tom Becker, 81 Lake Shore Dr, Chicago, IL 94105' }),
[{ status: 'held', codes: ['zip_state_mismatch'] }]);

write('email', '04-state-name-and-lost-zip-zero.eml', eml({ from: 'orders@client055.example', subject: 'PO TP-E04',
  body: `Account: C055\nPO: TP-E04\nSKU: hx 2201  Qty: 12\nService: standard\nShip to: dana ortiz\nAddress: 418 harbor street\nCity: HARTFORD\nState: Connecticut\nZIP: 6103` }),
[{ status: 'corrected', corrected: ['ship_to.state', 'ship_to.zip', 'sku'] }]);

write('email', '05-zip-plus4-and-service-synonym.eml', eml({ from: 'purchasing@client190.example', subject: 'PO TP-E05',
  body: `Account: C190\nPO: TP-E05\nSKU: HX-4410  Qty: 120 units\nService: overnight\n${addr({ ...ATLANTA, zip: '30309-1234' })}` }),
[{ status: 'corrected', corrected: ['ship_to.zip', 'commitment_type', 'quantity'] }]);

write('email', '06-same-day-after-cutoff.eml', eml({ from: 'purchasing@client190.example', subject: 'Urgent PO TP-E06', time: '10:20',
  body: `Account: C190\nPO: TP-E06\nSKU: HX-4410  Qty: 30\nService: same day please\n${addr(ATLANTA)}` }),
// With the desk on, same-day stands after 08:00 (an info issue; the Wave Planner decides); "same day please" is still
// corrected to the service code.
[{ status: 'corrected', codes: ['same_day_after_cutoff'], corrected: ['commitment_type'] }]);

write('email', '07-unknown-sender.eml', eml({ from: 'someone@randomco.example', subject: 'Order',
  body: `PO: TP-E07\nSKU: HX-1 Qty: 2\n${addr(HARTFORD)}` }),
[{ status: 'rejected', codes: ['missing_client'] }]);

write('email', '08-account-that-does-not-exist.eml', eml({ from: 'orders@client055.example', subject: 'PO TP-E08',
  body: `Account: C999\nPO: TP-E08\nSKU: HX-1 Qty: 2\n${addr(HARTFORD)}` }),
[{ status: 'rejected', codes: ['unknown_client'] }]);

write('email', '09-three-orders-one-bad-quantity.eml', eml({ from: 'orders@client055.example', subject: 'Three orders',
  body: `Account: C055\nPO: TP-E09A\nSKU: HX-2201 Qty: 5\n${addr(HARTFORD)}\n---\nPO: TP-E09B\nSKU: HX-2202 Qty: 6\n${addr(HARTFORD)}\n---\nPO: TP-E09C\nSKU: HX-2203 Qty: forty\n${addr(HARTFORD)}` }),
[{ status: 'accepted' }, { status: 'accepted' }, { status: 'held', codes: ['invalid_quantity'] }]);

write('email', '10-csv-attachment-mixed.eml', eml({ from: 'Orders <orders@client055.example>', subject: 'Weekly orders (attached)',
  body: 'Hi team, this week\'s orders are attached.',
  attachments: [{ name: 'orders.csv', content: [
    'PO Number,SKU,Quantity,Service,Ship To Name,Address,City,State,Zip',
    'TP-C01,HX-2201,10,next day,Dana Ortiz,418 Harbor Street,Hartford,CT,06103',
    'TP-C02,HX-2202,4,standard,Sam Lee,77 Oak Ave,Columbus,OH,',
    'TP-C03,HX-2203,8,standard,Jo Smith,12 Elm St,Boston,Massachusetts,2108',
    'TP-C04,??,3,standard,Jo Smith,12 Elm St,Boston,MA,02108',
    'TP-C01,HX-2201,10,next day,Dana Ortiz,418 Harbor Street,Hartford,CT,06103',
  ].join('\r\n') }] }),
[{ status: 'accepted' }, { status: 'held', codes: ['invalid_zip'] }, { status: 'corrected', corrected: ['ship_to.state', 'ship_to.zip'] },
  { status: 'held', codes: ['invalid_sku'] }, { status: 'duplicate', codes: ['duplicate_order'] }]);

write('email', '11-html-only-email.eml', eml({ from: 'orders@client263.example', subject: 'PO TP-E11',
  html: '<html><body><p>Account: C263</p><p>PO: TP-E11</p><table><tr><td>SKU: HX-118</td></tr><tr><td>Qty: 9</td></tr></table>'
    + '<div>Ship to: Tom Becker</div><div>Address: 81 Lake Shore Dr</div><div>City: Chicago</div><div>State: IL</div><div>ZIP: 60611</div></body></html>' }),
[{ status: 'accepted' }]);

write('email', '12-base64-encoded-body.eml', eml({ from: 'orders@client263.example', subject: '=?UTF-8?B?T3JkZXIgKGVuY29kZWQp?=', encoding: 'base64',
  body: 'Account: C263\nSKU: HX-118 Qty: 3\nService: standard\nShip to: Tom Becker\nAddress: 81 Lake Shore Dr\nCity: Chicago\nState: IL\nZIP: 60611' }),
[{ status: 'accepted' }]);

write('email', '13-no-order-in-email.eml', eml({ from: 'orders@client055.example', subject: 'Question',
  body: 'Hi, can someone call me about last week\'s late delivery? Thanks.' }),
[{ status: 'rejected', codes: ['unparseable'] }]);

write('email', '14-duplicate-of-email-01.eml', eml({ from: 'orders@client055.example', subject: 'PO TP-E01 (resent)',
  body: `Account: C055\nPO: TP-E01\nSKU: HX-2201   Qty: 40\nService: next day\n${addr(HARTFORD)}` }),
[{ status: 'duplicate', codes: ['duplicate_order'] }]);

write('email', '15-unknown-service.eml', eml({ from: 'orders@client055.example', subject: 'PO TP-E15',
  body: `Account: C055\nPO: TP-E15\nSKU: HX-2201 Qty: 2\nService: teleport\n${addr(HARTFORD)}` }),
[{ status: 'accepted', codes: ['unknown_service'] }]);

write('email', '16-order-at-unusual-time.eml', eml({ from: 'orders@client055.example', subject: 'PO TP-E16', time: '21:40',
  body: `Account: C055\nPO: TP-E16\nSKU: HX-2201 Qty: 2\nService: standard\n${addr(HARTFORD)}` }),
[{ status: 'accepted', codes: ['unusual_time'] }]);

write('email', '17-body-names-another-client.eml', eml({ from: 'orders@client055.example', subject: 'PO TP-E17',
  body: `Account: C190\nPO: TP-E17\nSKU: HX-4410 Qty: 2\nService: standard\n${addr(ATLANTA)}` }),
[{ status: 'accepted', codes: ['client_mismatch'] }]);

// ---------- EDI (ANSI X12 850) ----------
const isa = (sender) => `ISA*00*          *00*          *ZZ*${sender.padEnd(15)}*ZZ*HALCYON        *261027*0705*U*00401*000000101*0*P*>~GS*PO*${sender}*HALCYON*20261027*0705*1*X*004010~`;
const tx = (n, po, svc, a, sku, qty, seCount) => {
  const segs = [`ST*850*${n}`, `BEG*00*SA*${po}**20261027`, ...(svc ? [`TD5*****${svc}`] : []), `N1*ST*${a.name}`, `N3*${a.street}`, `N4*${a.city}*${a.state}*${a.zip}`, `PO1*1*${qty}*EA***VP*${sku}`];
  return `${segs.join('~')}~SE*${seCount ?? segs.length + 1}*${n}~`;
};
write('edi', '850-two-valid-orders.edi', `${isa('C190')}${tx('0001', 'TP-X01', 'NEXT DAY', ATLANTA, 'HX-4410', 20)}${tx('0002', 'TP-X02', 'STANDARD', ATLANTA, 'HX-4411', 8)}GE*2*1~IEA*1*000000101~`,
  [{ status: 'accepted' }, { status: 'accepted' }]);
write('edi', '850-bad-zip-and-bad-segment-count.edi', `${isa('C190')}${tx('0001', 'TP-X03', 'STANDARD', { ...ATLANTA, zip: '10001' }, 'HX-4410', 5)}${tx('0002', 'TP-X04', 'STANDARD', ATLANTA, 'HX-4410', 5, 42)}GE*2*1~IEA*1*000000101~`,
  [{ status: 'held', codes: ['zip_state_mismatch'] }, { status: 'rejected', codes: ['edi_structure'] }]);
write('edi', '850-not-x12.edi', 'PO,SKU,QTY\nTP-X05,HX-1,2\n', [{ status: 'rejected', codes: ['edi_structure'] }]);

// ---------- API payloads (sent by run-test-pack.mjs after logging in as C055) ----------
const apiAddr = { ...HARTFORD };
write('api', '01-single-clean-order.json', JSON.stringify({ client_order_ref: 'TP-A01', sku: 'HX-2201', quantity: 5, service: 'next_day', ship_to: apiAddr }, null, 2),
  [{ status: 'accepted' }]);
write('api', '02-batch-every-error-type.json', JSON.stringify({ orders: [
  { client_order_ref: 'TP-A02', sku: 'HX-2201', quantity: 1, service: 'standard', ship_to: apiAddr },
  { client_order_ref: 'TP-A03', sku: 'hx2201', quantity: '7', service: 'Express', ship_to: { ...apiAddr, state: 'connecticut', zip: '6103' } },
  { client_order_ref: 'TP-A04', sku: 'HX-2201', quantity: 2, service: 'standard', ship_to: { ...apiAddr, street: '' } },
  { client_order_ref: 'TP-A05', sku: 'HX-2201', quantity: -3, service: 'standard', ship_to: apiAddr },
  { client_order_ref: 'TP-A06', sku: 'HX-2201', quantity: 2, service: 'same_day', received_at: '2026-10-27T11:05', ship_to: apiAddr },
  { client_order_ref: 'TP-A07', sku: 'HX-2201', quantity: 9000, service: 'standard', ship_to: apiAddr },
  { client_order_ref: 'TP-A08', quantity: 2, service: 'standard', ship_to: { ...apiAddr, state: 'XX' } },
  { client_order_ref: 'TP-A02', sku: 'HX-2201', quantity: 1, service: 'standard', ship_to: apiAddr },
] }, null, 2), [
  { status: 'accepted' }, { status: 'corrected', corrected: ['sku', 'commitment_type', 'ship_to.state', 'ship_to.zip'] },
  { status: 'held', codes: ['missing_street'] }, { status: 'held', codes: ['invalid_quantity'] },
  { status: 'accepted', codes: ['same_day_after_cutoff'] }, { status: 'accepted', codes: ['unusual_quantity'] },
  { status: 'held', codes: ['missing_sku', 'invalid_state'] }, { status: 'duplicate', codes: ['duplicate_order'] },
]);
write('api', '03-order-for-another-client.json', JSON.stringify({ client_id: 'C190', client_order_ref: 'TP-A09', sku: 'HX-1', quantity: 1, ship_to: apiAddr }, null, 2),
  { http: 403 });

// ---------- Client file drop (SFTP-style CSV; client from the file name) ----------
write('files', 'C263_orders.csv', [
  'po,sku,qty,service,name,street,city,state,zip',
  'TP-F01,HX-118,4,standard,Tom Becker,81 Lake Shore Dr,Chicago,IL,60611',
  'TP-F02,HX-118,4,ND,Tom Becker,81 Lake Shore Dr,Chicago,Illinois,60611',
  'TP-F03,HX-118,0,standard,Tom Becker,81 Lake Shore Dr,Chicago,IL,60611',
].join('\n'), [{ status: 'accepted' }, { status: 'corrected', corrected: ['commitment_type', 'ship_to.state'] }, { status: 'held', codes: ['invalid_quantity'] }]);

fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(expected, null, 2));
console.log(`Wrote ${Object.keys(expected).length} test files to ${OUT}`);
