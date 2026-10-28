// Email channel: turns a parsed email (body text + CSV attachments) into raw order records.
// One email can carry several orders: blocks in the body separated by a line of --- or ===,
// and/or one per row of a CSV attachment.
import { parseEmailOrder } from '../../rules.js';
import { parseCsv } from './csv.js';

const SEPARATOR = /^\s*(?:-{3,}|={3,})\s*$/m;
const grab = (text, re) => text.match(re)?.[1]?.trim() || '';
// PO number under its common labels: PO, PO Number, P.O., Purchase order, Order ref, Order number. Must contain a digit.
const PO_RE = /(?:^|[^\w])(?:p\.?[ \t]?o\.?|purchase[ \t]+order|order[ \t]+(?:ref(?:erence)?|number|no\.?))(?:[ \t]*(?:number|no\.?|#))?[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)/i;

// Sender domain -> client id, e.g. orders@client055.example -> C055.
export const clientFromSender = (from = '') => {
  const m = from.match(/@client(\d{1,3})\./i);
  return m ? `C${m[1].padStart(3, '0')}` : '';
};

// "Tue, 27 Oct 2026 07:15:00 +0000" -> "2026-10-27T07:15" in the sender's own clock.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function emailTimestamp(date) {
  const m = String(date).match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}`;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date) ? date.slice(0, 16) : null;
}

// Drop quoted history from replies and forwards: "> ..." lines and everything after "On <date>, <name> wrote:"
// or an "-----Original Message-----" / "---------- Forwarded message" marker that is followed by quoted text.
export function stripQuoted(text) {
  const cut = text.search(/^\s*(On .{4,120}wrote:|-{2,}\s*Original Message\s*-{2,})\s*$/im);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  return body.split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join('\n');
}

const ACCOUNT_RE = /\b(?:account|customer|client)\b[ \t]*(?:no\.?|number|#)?[ \t]*[:#]?[ \t]*(C\d{1,3})\b/i;

const looksLikeOrder = (t) => /\b(sku|item|product|ship to|deliver to|address|qty|quantity)\b/i.test(t);

// The strict intake parser rejects values like "Connecticut", "6103" or "hx 2201". Here the raw labelled
// value is kept instead, so the normaliser can repair it and report exactly what it changed.
function fromBlock(block, ctx) {
  const p = parseEmailOrder(block);
  const ownAccount = grab(block, ACCOUNT_RE);
  const labelled = (re) => grab(block, re);
  const ship_to = { ...p.ship_to };
  const state = labelled(/^[ \t]*state[ \t]*:?[ \t]*(.+)$/im);
  const zip = labelled(/^[ \t]*(?:zip|zip code|postcode|postal code)[ \t]*:?[ \t]*(.+)$/im);
  if (state) ship_to.state = state;
  if (zip) ship_to.zip = zip;
  return {
    ...ctx,
    // An account named once at the top of the email applies to every order in it.
    client_hint: ownAccount || ctx.body_account || p.client_id || ctx.client_sender,
    client_order_ref: grab(block, PO_RE) || ctx.subject_ref,
    sku: labelled(/\b(?:sku|item|product)\b\s*[:#]?\s*([A-Za-z]{2,4}[\s_-]?\d+|\S+)/i) || p.sku,
    quantity: labelled(/\b(?:qty|quantity)\b\s*[:#]?\s*([^\n,]+?)\s*(?:$|,|\s{2,})/im) || p.quantity,
    service: labelled(/^[ \t]*(?:service|delivery|shipping)[ \t]*:?[ \t]*(.+)$/im) || (p.commitment_type !== 'standard' ? p.commitment_type : ''),
    ship_to,
  };
}

const COLUMN = {
  client_hint: ['client', 'account', 'customer', 'clientid'],
  client_order_ref: ['po', 'ponumber', 'pono', 'order', 'orderref', 'orderno', 'reference', 'ref'],
  sku: ['sku', 'item', 'product', 'itemcode'],
  quantity: ['qty', 'quantity', 'units'],
  service: ['service', 'servicelevel', 'delivery', 'shipping'],
  name: ['name', 'recipient', 'shiptoname', 'attn', 'contact'],
  street: ['street', 'address', 'address1', 'shiptoaddress', 'addressline1'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  zip: ['zip', 'zipcode', 'postcode', 'postalcode'],
};
const key = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function fromCsvRow(row, ctx) {
  const get = (field) => {
    const col = Object.keys(row).find((h) => COLUMN[field].includes(key(h)));
    return col ? row[col] : '';
  };
  return {
    ...ctx,
    client_hint: get('client_hint') || ctx.client_sender,
    client_order_ref: get('client_order_ref'),
    sku: get('sku'),
    quantity: get('quantity'),
    service: get('service'),
    ship_to: { name: get('name'), street: get('street'), city: get('city'), state: get('state'), zip: get('zip') },
  };
}

/** @param email { from, subject, date, text, attachments: [{ filename, content }] } */
export function emailToRecords(email) {
  const ctx = {
    client_sender: clientFromSender(email.from),
    subject_ref: grab(email.subject || '', PO_RE),
    received_ts: emailTimestamp(email.date),
  };
  const body = stripQuoted(email.text);
  ctx.body_account = grab(body, ACCOUNT_RE);
  const records = [];
  body.split(SEPARATOR).filter(looksLikeOrder)
    .forEach((block, i) => records.push({ ...fromBlock(block, ctx), source_ref: `body#${i + 1}` }));
  for (const a of email.attachments || []) {
    if (!/\.csv$/i.test(a.filename) && !/csv/.test(a.contentType || '')) continue;
    parseCsv(a.content).forEach((row, i) => records.push({ ...fromCsvRow(row, ctx), source_ref: `${a.filename}#${i + 2}` }));
  }
  // Nothing order-like at all: keep one empty record so the email is answered, not silently dropped.
  if (!records.length) records.push({ ...ctx, client_hint: ctx.client_sender, source_ref: 'body', unparseable: true, ship_to: {} });
  return records.map(({ subject_ref, body_account, ...r }) => r);
}
