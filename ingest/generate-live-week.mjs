// Synthetic "live week" of inbound client orders, Mon 26 Oct – Sun 1 Nov 2026.
//
// Built from the supplied dataset so it behaves like Halcyon's real traffic: each client's share of volume,
// usual channel, home region and service mix come from deliveries.csv / clients.csv. On top of that it
// injects the data problems seen in the history (and a few the history can't show), at realistic rates per
// channel, and records every injected defect as ground truth in manifest.json so run-live-week.mjs can score
// exactly what the gateway caught.
//
//   node ingest/generate-live-week.mjs [--orders 1900] [--seed 7]
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((a) => a.trim().split(/\s+/)));
const TARGET_ORDERS = Number(args.orders || 1900);
const DATA = process.env.DATASET || path.join(import.meta.dirname, '../db/data');
const OUT = path.join(import.meta.dirname, 'live-week');

// ---------- Deterministic randomness ----------
let seed = Number(args.seed || 7) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const chance = (p) => rnd() < p;
const weighted = (entries) => { const total = entries.reduce((s, [, w]) => s + w, 0); let r = rnd() * total; for (const [v, w] of entries) { if ((r -= w) <= 0) return v; } return entries.at(-1)[0]; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// ---------- Learn the shape of real traffic from the supplied data ----------
const csv = (file) => {
  const [head, ...rows] = fs.readFileSync(path.join(DATA, file), 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
};
const clients = csv('clients.csv');
const deliveries = csv('deliveries.csv');
const profile = Object.fromEntries(clients.map((c) => [c.client_id, { ...c, n: 0, regions: {}, services: {}, hours: {} }]));
for (const d of deliveries) {
  const p = profile[d.client_id];
  p.n++;
  p.regions[d.destination_region] = (p.regions[d.destination_region] || 0) + 1;
  p.services[d.commitment_type] = (p.services[d.commitment_type] || 0) + 1;
  const h = Number(d.order_received_ts.slice(11, 13));
  p.hours[h] = (p.hours[h] || 0) + 1;
}
const clientWeights = Object.values(profile).map((p) => [p, p.n]);

// ---------- Address book: real US cities with valid ZIPs, by Halcyon region ----------
const CITIES = {
  Midwest: [['Chicago', 'IL', '60611'], ['Columbus', 'OH', '43215'], ['Indianapolis', 'IN', '46204'], ['Detroit', 'MI', '48226'], ['Minneapolis', 'MN', '55401'],
    ['Milwaukee', 'WI', '53202'], ['Kansas City', 'MO', '64105'], ['Des Moines', 'IA', '50309'], ['Omaha', 'NE', '68102'], ['St. Louis', 'MO', '63101']],
  Northeast: [['Hartford', 'CT', '06103'], ['Boston', 'MA', '02108'], ['New York', 'NY', '10001'], ['Philadelphia', 'PA', '19103'], ['Providence', 'RI', '02903'],
    ['Newark', 'NJ', '07102'], ['Portland', 'ME', '04101'], ['Burlington', 'VT', '05401'], ['Baltimore', 'MD', '21202'], ['Manchester', 'NH', '03101']],
  Southeast: [['Atlanta', 'GA', '30309'], ['Charlotte', 'NC', '28202'], ['Nashville', 'TN', '37203'], ['Miami', 'FL', '33131'], ['Richmond', 'VA', '23219'],
    ['Birmingham', 'AL', '35203'], ['Charleston', 'SC', '29401'], ['Louisville', 'KY', '40202'], ['New Orleans', 'LA', '70112'], ['Dallas', 'TX', '75201']],
  West: [['San Francisco', 'CA', '94105'], ['Los Angeles', 'CA', '90012'], ['Seattle', 'WA', '98101'], ['Portland', 'OR', '97204'], ['Denver', 'CO', '80202'],
    ['Phoenix', 'AZ', '85004'], ['Salt Lake City', 'UT', '84101'], ['Las Vegas', 'NV', '89101'], ['Boise', 'ID', '83702'], ['Albuquerque', 'NM', '87102']],
};
const STATE_NAME = { IL: 'Illinois', OH: 'Ohio', IN: 'Indiana', MI: 'Michigan', MN: 'Minnesota', WI: 'Wisconsin', MO: 'Missouri', IA: 'Iowa', NE: 'Nebraska',
  CT: 'Connecticut', MA: 'Massachusetts', NY: 'New York', PA: 'Pennsylvania', RI: 'Rhode Island', NJ: 'New Jersey', ME: 'Maine', VT: 'Vermont', MD: 'Maryland',
  NH: 'New Hampshire', GA: 'Georgia', NC: 'North Carolina', TN: 'Tennessee', FL: 'Florida', VA: 'Virginia', AL: 'Alabama', SC: 'South Carolina', KY: 'Kentucky',
  LA: 'Louisiana', TX: 'Texas', CA: 'California', WA: 'Washington', OR: 'Oregon', CO: 'Colorado', AZ: 'Arizona', UT: 'Utah', NV: 'Nevada', ID: 'Idaho', NM: 'New Mexico' };
const STATE_TYPO = { CT: 'Conneticut', PA: 'Pensylvania', MA: 'Massachusets', TN: 'Tennesee', MN: 'Minnesotta', CA: 'Califronia', NJ: 'New Jersy', WA: 'Washingon' };
const STREETS = ['Harbor Street', 'Oak Avenue', 'Market Street', 'Lake Shore Drive', 'Peachtree Road', 'Elm Street', 'Industrial Parkway', 'Commerce Drive',
  'Maple Avenue', 'Riverside Boulevard', 'Union Street', 'Logistics Way', 'Cedar Lane', 'Warehouse Row', 'Main Street', 'Park Avenue'];
const UNITS = ['', '', '', '', ' Suite 300', ' Apt 4B', ' Unit 12', ' Floor 2', ' Dock 7'];
const FIRST = ['Dana', 'Priya', 'Tom', 'Ana', 'Sam', 'José', 'Zoë', 'Wei', 'Fatima', 'Liam', 'Grace', 'Omar', 'Hannah', 'Kenji', 'Maria', 'Ravi', 'Chloe', 'Diego', 'Aisha', 'Noah'];
const LAST = ['Ortiz', 'Natarajan', 'Becker', 'Ruiz', 'Lee', 'Álvarez', 'Novak', 'Chen', 'Haddad', "O'Brien", 'Kim', 'Farouk', 'Schmidt', 'Tanaka', 'Rossi', 'Patel', 'Dubois', 'Herrera', 'Mensah', 'Walsh'];
const SKUS = ['HX-2201', 'HX-2202', 'HX-4410', 'HX-118', 'HX-3002', 'HX-905', 'HX-1270', 'HX-6630', 'HX-77', 'HX-5150'];

// ---------- Defect catalogue: what is injected, how often, and what the gateway should do ----------
// expect: issue code it should raise, or the field it should auto-correct; outcome: status it should give.
export const DEFECTS = {
  state_full_name: { label: 'State written in full', expect: { fix: 'ship_to.state' }, outcome: 'corrected' },
  zip_lost_zero: { label: 'ZIP lost its leading zero (spreadsheet)', expect: { fix: 'ship_to.zip' }, outcome: 'corrected' },
  zip_plus4: { label: 'ZIP+4 instead of 5 digits', expect: { fix: 'ship_to.zip' }, outcome: 'corrected' },
  service_synonym: { label: 'Service in the client’s own words', expect: { fix: 'commitment_type' }, outcome: 'corrected' },
  qty_with_units: { label: 'Quantity with units ("12 units")', expect: { fix: 'quantity' }, outcome: 'corrected' },
  sku_format: { label: 'SKU spacing / case ("hx 2201")', expect: { fix: 'sku' }, outcome: 'corrected' },
  same_day_after_cutoff: { label: 'Same-day requested after 8am', expect: { issue: 'same_day_after_cutoff' }, outcome: 'accepted' }, // the desk keeps same-day; the Wave Planner decides
  missing_house_number: { label: 'Street without house number', expect: { issue: 'missing_house_number' }, outcome: 'held' },
  missing_city: { label: 'City missing', expect: { issue: 'missing_city' }, outcome: 'held' },
  missing_zip: { label: 'ZIP missing', expect: { issue: 'invalid_zip' }, outcome: 'held' },
  zip_state_mismatch: { label: 'ZIP belongs to another state', expect: { issue: 'zip_state_mismatch' }, outcome: 'held' },
  state_typo: { label: 'State misspelled ("Conneticut")', expect: { issue: 'invalid_state' }, outcome: 'held' },
  invalid_quantity: { label: 'Quantity zero, negative or in words', expect: { issue: 'invalid_quantity' }, outcome: 'held' },
  invalid_sku: { label: 'SKU unreadable ("TBD", "??")', expect: { issue: 'invalid_sku' }, outcome: 'held' },
  missing_sku: { label: 'SKU missing', expect: { issue: 'missing_sku' }, outcome: 'held' },
  unknown_sender: { label: 'Email from an unknown sender', expect: { issue: 'missing_client' }, outcome: 'rejected' },
  unknown_client: { label: 'Account number that does not exist', expect: { issue: 'unknown_client' }, outcome: 'rejected' },
  no_order_in_email: { label: 'Email with no order in it', expect: { issue: 'unparseable' }, outcome: 'rejected' },
  edi_bad_segment_count: { label: 'EDI transaction corrupted', expect: { issue: 'edi_structure' }, outcome: 'rejected' },
  duplicate_resend: { label: 'Same PO sent again', expect: { issue: 'duplicate_order' }, outcome: 'duplicate' },
  unusual_quantity: { label: 'Unusually large quantity', expect: { issue: 'unusual_quantity' }, outcome: 'accepted' },
  unusual_time: { label: 'Order at an hour the client never orders', expect: { issue: 'unusual_time' }, outcome: 'accepted' },
  client_mismatch: { label: 'Body names a different client than the sender', expect: { issue: 'client_mismatch' }, outcome: 'accepted' },
};
// Probability per order, by channel. Email is hand-written, so it carries most of the mess (28% bad addresses in history).
const RATES = {
  Email: { state_full_name: 0.05, zip_lost_zero: 0.03, zip_plus4: 0.03, service_synonym: 0.12, qty_with_units: 0.08, sku_format: 0.06,
    missing_house_number: 0.07, missing_city: 0.05, missing_zip: 0.04, zip_state_mismatch: 0.03, state_typo: 0.03,
    invalid_quantity: 0.02, invalid_sku: 0.015, missing_sku: 0.01, unusual_quantity: 0.005, client_mismatch: 0.01 },
  API: { state_full_name: 0.01, zip_lost_zero: 0.01, service_synonym: 0.03, qty_with_units: 0.01, sku_format: 0.01,
    missing_house_number: 0.01, missing_city: 0.01, missing_zip: 0.008, zip_state_mismatch: 0.008, invalid_quantity: 0.005, unusual_quantity: 0.004 },
  EDI: { zip_plus4: 0.03, service_synonym: 0.02, missing_house_number: 0.01, missing_city: 0.01, missing_zip: 0.008, zip_state_mismatch: 0.008,
    invalid_quantity: 0.004, invalid_sku: 0.004, unusual_quantity: 0.004 },
  File: { zip_lost_zero: 0.12, state_full_name: 0.04, service_synonym: 0.05, missing_city: 0.03, missing_zip: 0.03, invalid_quantity: 0.02, sku_format: 0.04 },
};
const ADDRESS_DEFECTS = ['missing_house_number', 'missing_city', 'missing_zip', 'zip_state_mismatch', 'state_typo'];
const ZIP_FAMILY = ['missing_zip', 'zip_state_mismatch', 'zip_plus4', 'zip_lost_zero'];

// ---------- Build orders ----------
const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const DAY_WEIGHT = [1.25, 1.1, 1.05, 1.0, 1.05, 0.35, 0.2];           // Monday catch-up, quiet weekend
const SERVICE_PHRASES = { same_day: ['same day', 'SAME DAY', 'same-day please', 'ASAP', 'rush', 'urgent'], next_day: ['next day', 'overnight', 'Next-Day', 'express', 'priority'], standard: ['standard', 'ground', 'economy', 'regular'] };
const pad = (n) => String(n).padStart(2, '0');
const CANONICAL = { same_day: 'same day', next_day: 'next day', standard: 'standard' };

let poSeq = 1000;
function makeOrder(client, channel, day) {
  const hours = Object.entries(client.hours).map(([h, w]) => [Number(h), w]);
  const hour = weighted(hours.length ? hours : [[9, 1]]);
  const region = weighted(Object.entries(client.regions));
  const [city, state, zip] = pick(CITIES[region]);
  const service = weighted(Object.entries(client.services));
  const o = {
    client_id: client.client_id, channel, po: `LW-${client.client_id}-${++poSeq}`, received: `${day}T${pad(hour)}:${pad(int(0, 59))}`,
    sku: pick(SKUS), quantity: String(int(1, 120)), service, serviceText: CANONICAL[service],
    ship_to: { name: `${pick(FIRST)} ${pick(LAST)}`, street: `${int(1, 9800)} ${pick(STREETS)}${pick(UNITS)}`, city, state, zip },
    defects: [],
  };
  const add = (d) => o.defects.push(d);
  if (service === 'same_day' && hour >= 8) add('same_day_after_cutoff');
  const rates = RATES[channel];
  let addressHit = false;
  for (const [d, p] of Object.entries(rates)) {
    if (!chance(p)) continue;
    if (ADDRESS_DEFECTS.includes(d)) { if (addressHit) continue; addressHit = true; }   // one address fault per order keeps ground truth clean
    if (d === 'zip_lost_zero' && !zip.startsWith('0')) continue;
    if ((d === 'state_typo') && !STATE_TYPO[state]) continue;
    if (d === 'state_full_name' && (addressHit || o.defects.includes('state_typo'))) continue;
    // At most one ZIP problem per order, so the ground truth stays unambiguous.
    if (ZIP_FAMILY.includes(d) && o.defects.some((x) => ZIP_FAMILY.includes(x))) continue;
    if (d === 'service_synonym' && service === 'same_day' && hour >= 8) continue;      // keep the cutoff case unambiguous
    if (['invalid_quantity', 'qty_with_units', 'unusual_quantity'].includes(d) && o.defects.some((x) => ['invalid_quantity', 'qty_with_units', 'unusual_quantity'].includes(x))) continue;
    if (['invalid_sku', 'missing_sku', 'sku_format'].includes(d) && o.defects.some((x) => ['invalid_sku', 'missing_sku', 'sku_format'].includes(x))) continue;
    add(d);
  }
  // Apply the defects to the order's fields.
  const t = o.ship_to;
  for (const d of o.defects) {
    if (d === 'state_full_name') t.state = chance(0.5) ? STATE_NAME[state] : STATE_NAME[state].toUpperCase();
    if (d === 'zip_lost_zero') t.zip = String(Number(zip));
    if (d === 'zip_plus4') t.zip = `${zip}-${int(1000, 9999)}`;
    if (d === 'service_synonym') o.serviceText = pick(SERVICE_PHRASES[service].filter((x) => x.toLowerCase().replace(/[\s-]+/g, '_') !== service));
    if (d === 'qty_with_units') o.quantity = `${o.quantity} ${pick(['units', 'pcs', 'ea', 'pieces'])}`;
    if (d === 'sku_format') o.sku = pick([o.sku.toLowerCase().replace('-', ' '), o.sku.replace('-', ''), o.sku.toLowerCase()]);
    if (d === 'missing_house_number') t.street = t.street.replace(/^\d+\s+/, '');
    if (d === 'missing_city') t.city = '';
    if (d === 'missing_zip') t.zip = '';
    if (d === 'zip_state_mismatch') t.zip = pick(CITIES[pick(Object.keys(CITIES).filter((r) => r !== region))])[2];
    if (d === 'state_typo') t.state = STATE_TYPO[state];
    if (d === 'invalid_quantity') o.quantity = pick(['0', '-2', 'forty', 'tbc']);
    if (d === 'invalid_sku') o.sku = pick(['TBD', '??', 'see attached']);
    if (d === 'missing_sku') o.sku = '';
    if (d === 'unusual_quantity') o.quantity = String(int(6000, 12000));
  }
  return o;
}

// Expected outcome: reject > duplicate > hold > corrected > accepted.
const ORDER = ['rejected', 'duplicate', 'held', 'corrected', 'accepted'];
const expectedStatus = (o) => (o.defects.length ? o.defects.map((d) => DEFECTS[d].outcome).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] : 'accepted');

// ---------- Render each channel's real wire format ----------
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
const MONTH = { '10': 'Oct', '11': 'Nov' };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const rfcDate = (ts) => `${DOW[DAYS.indexOf(ts.slice(0, 10))]}, ${Number(ts.slice(8, 10))} ${MONTH[ts.slice(5, 7)]} ${ts.slice(0, 4)} ${ts.slice(11, 16)}:00 +0000`;
const senderOf = (cid) => `${pick(['orders', 'purchasing', 'buyer', 'ops', 'supply'])}@client${cid.slice(1)}.example`;
const block = (o, accountLine) => [
  accountLine,
  pick(['PO', 'PO Number', 'Purchase order']) + `: ${o.po}`,
  o.sku === '' ? null : `${pick(['SKU', 'Item', 'Product'])}: ${o.sku}   ${pick(['Qty', 'Quantity'])}: ${o.quantity}`,
  o.sku === '' ? `Qty: ${o.quantity}` : null,
  `${pick(['Service', 'Delivery', 'Shipping'])}: ${o.serviceText}`,
  `${pick(['Ship to', 'Deliver to', 'Attn'])}: ${o.ship_to.name}`,
  `Address: ${o.ship_to.street}`, `City: ${o.ship_to.city}`, `State: ${o.ship_to.state}`, `ZIP: ${o.ship_to.zip}`,
].filter((l) => l !== null).join('\n');
const SIGNATURES = ['\n\n--\nPurchasing team\nTel 555-0100', '\n\nThanks,\nOps desk', '\n\nRegards\n\nSent from my phone', ''];

function emailFile({ from, subject, date, text, html, csvAttachment, encoding }) {
  const headers = `From: ${from}\nTo: orders@halcyon.example\nSubject: ${subject}\nDate: ${date}\nMessage-ID: <${int(1e8, 9e8)}@mail.example>\nMIME-Version: 1.0\n`;
  if (csvAttachment) {
    return crlf(`${headers}Content-Type: multipart/mixed; boundary="lw"\n\n--lw\nContent-Type: text/plain; charset=utf-8\n\n${text}\n`
      + `--lw\nContent-Type: text/csv; name="${csvAttachment.name}"\nContent-Disposition: attachment; filename="${csvAttachment.name}"\nContent-Transfer-Encoding: 7bit\n\n${csvAttachment.content}\n--lw--\n`);
  }
  if (html) return crlf(`${headers}Content-Type: text/html; charset=utf-8\n\n${html}\n`);
  if (encoding === 'base64') return crlf(`${headers}Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${b64(text)}\n`);
  return crlf(`${headers}Content-Type: text/plain; charset=utf-8\n\n${text}\n`);
}
const csvRows = (orders, sep = ',') => {
  const q = (v) => (/[",;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['PO Number', 'SKU', 'Quantity', 'Service', 'Ship To Name', 'Address', 'City', 'State', 'Zip'];
  return [head.join(sep), ...orders.map((o) => [o.po, o.sku, o.quantity, o.serviceText, o.ship_to.name, o.ship_to.street, o.ship_to.city, o.ship_to.state, o.ship_to.zip].map(q).join(sep))].join('\r\n');
};
function ediFile(sender, orders, ts, { corruptIndex = -1 } = {}) {
  const ymd = ts.slice(0, 10).replace(/-/g, '');
  const hm = ts.slice(11, 16).replace(':', '');
  const ctrl = String(int(1, 999999999)).padStart(9, '0');
  const txs = orders.map((o, i) => {
    const n = String(i + 1).padStart(4, '0');
    const segs = [`ST*850*${n}`, `BEG*00*SA*${o.po}**${ymd}`, `TD5*****${o.serviceText.toUpperCase()}`, `N1*ST*${o.ship_to.name}`, `N3*${o.ship_to.street}`,
      `N4*${o.ship_to.city}*${o.ship_to.state}*${o.ship_to.zip}`, `PO1*1*${o.quantity}*EA***VP*${o.sku}`];
    return `${segs.join('~')}~SE*${i === corruptIndex ? segs.length + 7 : segs.length + 1}*${n}~`;
  });
  const lineBreaks = chance(0.4) ? '\n' : '';
  return `ISA*00*          *00*          *ZZ*${sender.padEnd(15)}*ZZ*HALCYON        *${ymd.slice(2)}*${hm}*U*00401*${ctrl}*0*P*>~${lineBreaks}GS*PO*${sender}*HALCYON*${ymd}*${hm}*1*X*004010~${lineBreaks}`
    + txs.join(lineBreaks) + `GE*${orders.length}*1~IEA*1*${ctrl}~`;
}

// ---------- Generate the week ----------
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['email', 'edi', 'api', 'files']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const manifest = [];
const dayTotal = DAY_WEIGHT.reduce((s, w) => s + w, 0);
let fileSeq = 0;
const name = (dir, ext, label) => `${String(++fileSeq).padStart(4, '0')}-${label}.${ext}`;
const record = (dir, file, orders, extra = {}) => {
  manifest.push({ dir, file, ...extra, orders: orders.map((o) => ({ po: o.po, client_id: o.client_id, channel: o.channel, received: o.received, defects: o.defects, expected: expectedStatus(o) })) });
};
const sentOrders = [];

for (let di = 0; di < DAYS.length; di++) {
  const day = DAYS[di];
  let remaining = Math.round((TARGET_ORDERS * DAY_WEIGHT[di]) / dayTotal);
  while (remaining > 0) {
    const client = weighted(clientWeights);
    const ch = chance(0.9) ? client.primary_order_channel : pick(['API', 'EDI', 'Email']);
    if (ch === 'Email') {
      // 1–3 orders in the body, or a CSV attachment of 8–30 rows (3 in 20 emails)
      const asCsv = chance(0.15);
      const count = asCsv ? int(8, 30) : weighted([[1, 70], [2, 20], [3, 10]]);
      const orders = Array.from({ length: Math.min(count, Math.max(1, remaining)) }, () => makeOrder(client, 'Email', day));
      orders.forEach((o) => { o.received = orders[0].received; });
      for (const o of orders) if (o.defects.includes('same_day_after_cutoff') && o.service === 'same_day' && Number(o.received.slice(11, 13)) < 8) o.defects = o.defects.filter((d) => d !== 'same_day_after_cutoff');
      for (const o of orders) if (o.service === 'same_day' && Number(o.received.slice(11, 13)) >= 8 && !o.defects.includes('same_day_after_cutoff')) o.defects.push('same_day_after_cutoff');
      let from = senderOf(client.client_id);
      const accountLine = `Account: ${client.client_id}`;
      let firstAccount = accountLine;
      const special = weighted([['normal', 88], ['unknown_sender', 2.5], ['unknown_client', 1.5], ['client_mismatch', 0], ['unusual_time', 2], ['html', 3], ['base64', 2], ['forward', 1]]);
      if (special === 'unknown_sender') { from = `orders@${pick(['newco-trading', 'acme-retail', 'globex'])}.example`; firstAccount = ''; orders.forEach((o) => { o.defects = ['unknown_sender']; }); }
      if (special === 'unknown_client') { firstAccount = `Account: C${int(300, 899)}`; orders.forEach((o) => { o.defects = ['unknown_client']; }); }
      if (special === 'unusual_time') { const t = `${day}T${pick(['21', '22', '23'])}:${pad(int(0, 59))}`; orders.forEach((o) => { o.received = t; if (o.service === 'same_day') o.defects = o.defects.filter((d) => d !== 'same_day_after_cutoff').concat('same_day_after_cutoff'); o.defects.push('unusual_time'); }); }
      // CSV rows carry no account line, so a body/sender mismatch only exists in written emails.
      if (!asCsv && special !== 'unknown_sender' && special !== 'unknown_client' && orders.some((o) => o.defects.includes('client_mismatch'))) {
        const other = weighted(clientWeights.filter(([p]) => p.client_id !== client.client_id));
        firstAccount = `Account: ${other.client_id}`;
        orders.forEach((o) => { o.client_id = other.client_id; if (!o.defects.includes('client_mismatch')) o.defects.push('client_mismatch'); });
      }
      const date = rfcDate(orders[0].received);
      const subject = orders.length === 1 ? `${pick(['PO', 'Order', 'New order', 'Purchase order'])} ${orders[0].po}` : `${orders.length} orders`;
      let content;
      if (asCsv) {
        const sep = chance(0.3) ? ';' : ',';
        const bom = chance(0.3) ? '﻿' : '';
        content = emailFile({ from, subject: `Weekly orders ${day}`, date, text: `Hi, this week's orders are attached.${pick(SIGNATURES)}`, csvAttachment: { name: `orders-${day}.csv`, content: bom + csvRows(orders, sep) } });
        // CSV rows carry no account line: the client comes from the sender, so mismatches don't apply.
        orders.forEach((o) => { o.defects = o.defects.filter((d) => d !== 'client_mismatch'); });
      } else {
        const body = orders.map((o, i) => block(o, i === 0 ? firstAccount : null)).join(`\n${pick(['---', '----------', '==='])}\n`);
        const greeting = pick(['Hi team,', 'Hello,', 'Good morning,', 'Please process:', '']);
        let text = `${greeting}\n${body}${pick(SIGNATURES)}`;
        if (special === 'forward') {
          const old = makeOrder(client, 'Email', day);
          text = `Adding one more, see below.\n${body}\n\nOn ${rfcDate(orders[0].received)}, ${client.client_id} buyer wrote:\n${block(old, accountLine).split('\n').map((l) => `> ${l}`).join('\n')}`;
        }
        content = special === 'html'
          ? emailFile({ from, subject, date, html: `<html><body><p>${greeting}</p>${body.split('\n').map((l) => `<div>${l}</div>`).join('')}</body></html>` })
          : emailFile({ from, subject, date, text, encoding: special === 'base64' ? 'base64' : undefined });
      }
      const file = name('email', 'eml', special === 'normal' ? (asCsv ? 'csv-batch' : 'order') : special);
      fs.writeFileSync(path.join(OUT, 'email', file), content);
      record('email', file, orders, { special: asCsv ? 'csv' : special });
      sentOrders.push(...orders);
      remaining -= orders.length;
    } else if (ch === 'EDI') {
      const orders = Array.from({ length: Math.min(int(1, 6), Math.max(1, remaining)) }, () => makeOrder(client, 'EDI', day));
      orders.forEach((o) => { o.received = orders[0].received; o.defects = o.defects.filter((d) => d !== 'same_day_after_cutoff'); if (o.service === 'same_day' && Number(o.received.slice(11, 13)) >= 8) o.defects.push('same_day_after_cutoff'); });
      const corrupt = chance(0.03) ? int(0, orders.length - 1) : -1;
      if (corrupt >= 0) orders[corrupt].defects = ['edi_bad_segment_count'];
      const file = name('edi', 'edi', `850-${client.client_id}`);
      fs.writeFileSync(path.join(OUT, 'edi', file), ediFile(client.client_id, orders, orders[0].received, { corruptIndex: corrupt }));
      record('edi', file, orders);
      sentOrders.push(...orders);
      remaining -= orders.length;
    } else {
      const orders = Array.from({ length: Math.min(weighted([[1, 75], [5, 15], [20, 10]]), Math.max(1, remaining)) }, () => makeOrder(client, 'API', day));
      const file = name('api', 'json', `orders-${client.client_id}`);
      fs.writeFileSync(path.join(OUT, 'api', file), JSON.stringify({
        client_id: client.client_id,
        orders: orders.map((o) => ({ client_order_ref: o.po, sku: o.sku || undefined, quantity: /^-?\d+$/.test(o.quantity) ? Number(o.quantity) : o.quantity, service: o.serviceText, received_at: o.received, ship_to: o.ship_to })),
      }, null, 2));
      record('api', file, orders, { client_id: client.client_id, retry_with_same_key: chance(0.05) });
      sentOrders.push(...orders);
      remaining -= orders.length;
    }
  }
  // Clients re-sending orders they already sent ("did you get this?"): an email or API resend later the same day.
  for (let k = 0; k < Math.round(4 * DAY_WEIGHT[di]); k++) {
    const original = pick(sentOrders.filter((o) => o.received.startsWith(day) && o.channel !== 'File' && !o.defects.some((d) => ['unknown_sender', 'unknown_client', 'edi_bad_segment_count', 'client_mismatch'].includes(d))));
    if (!original) continue;
    const resend = { ...original, ship_to: { ...original.ship_to }, defects: ['duplicate_resend'] };
    if (original.channel === 'API') {
      const file = name('api', 'json', `resend-${original.client_id}`);
      fs.writeFileSync(path.join(OUT, 'api', file), JSON.stringify({ client_id: original.client_id, orders: [{ client_order_ref: resend.po, sku: resend.sku || undefined,
        quantity: /^-?\d+$/.test(resend.quantity) ? Number(resend.quantity) : resend.quantity, service: resend.serviceText, received_at: resend.received, ship_to: resend.ship_to }] }, null, 2));
      record('api', file, [resend], { client_id: original.client_id });
    } else {
      const file = name('email', 'eml', 'resend');
      fs.writeFileSync(path.join(OUT, 'email', file), emailFile({ from: senderOf(original.client_id), subject: `RE: ${original.po} - did you receive this?`, date: rfcDate(original.received),
        text: `Resending in case this didn't come through.\n${block(resend, `Account: ${original.client_id}`)}` }));
      record('email', file, [resend], { special: 'resend' });
    }
  }
  // A couple of emails a day that contain no order at all.
  for (let k = 0; k < (di < 5 ? 2 : 0); k++) {
    const c = weighted(clientWeights.filter(([p]) => p.primary_order_channel === 'Email'));
    const file = name('email', 'eml', 'no-order');
    fs.writeFileSync(path.join(OUT, 'email', file), emailFile({ from: senderOf(c.client_id), subject: pick(['Question about last delivery', 'Invoice query', 'Call me please', 'Holiday schedule?']),
      date: rfcDate(`${day}T${pad(int(8, 17))}:${pad(int(0, 59))}`), text: pick(['Hi, can someone call me about yesterday\'s late delivery?', 'Please send last month\'s invoice again.', 'Are you open on Monday?']) }));
    record('email', file, [{ po: null, client_id: c.client_id, channel: 'Email', received: day, defects: ['no_order_in_email'] }]);
  }
}
// Weekly SFTP-style file drops from three clients, with spreadsheet damage.
for (const [i, day] of [[0, DAYS[0]], [2, DAYS[2]], [4, DAYS[4]]]) {
  const c = weighted(clientWeights.filter(([p]) => p.primary_order_channel === 'EDI'));
  const orders = Array.from({ length: int(15, 35) }, () => makeOrder(c, 'File', day)).map((o) => ({ ...o, service: o.service === 'same_day' ? 'next_day' : o.service, serviceText: o.service === 'same_day' ? 'next day' : o.serviceText, defects: o.defects.filter((d) => d !== 'same_day_after_cutoff') }));
  const file = `${c.client_id}_weekly_${day}_${i}.csv`;
  fs.writeFileSync(path.join(OUT, 'files', file), csvRows(orders, chance(0.5) ? ';' : ','));
  record('files', file, orders);
}

const totals = manifest.flatMap((m) => m.orders);
const byDefect = {};
for (const o of totals) for (const d of o.defects) byDefect[d] = (byDefect[d] || 0) + 1;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  generated_for: 'Mon 26 Oct – Sun 1 Nov 2026', seed: Number(args.seed || 7), messages: manifest.length, orders: totals.length,
  clean_orders: totals.filter((o) => !o.defects.length).length, injected: byDefect, defect_catalogue: DEFECTS, files: manifest,
}, null, 2));
console.log(`Live week: ${manifest.length} messages, ${totals.length} orders (${totals.filter((o) => !o.defects.length).length} clean) -> ${OUT}`);
console.log('By channel:', Object.fromEntries(['Email', 'API', 'EDI', 'File'].map((c) => [c, totals.filter((o) => o.channel === c).length])));
console.log('Injected:', byDefect);
