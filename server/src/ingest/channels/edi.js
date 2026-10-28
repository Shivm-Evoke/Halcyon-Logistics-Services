// EDI channel: ANSI X12 850 purchase orders -> raw order records, plus a 997 acknowledgement.
// Supports the segments clients actually send for a parcel order: ISA/GS envelope, ST/SE, BEG,
// TD5 (service), N1/N3/N4 (ship-to), PO1 (line item), DTM*002 (requested delivery date).

export function parseX12(text) {
  const raw = String(text).replace(/^﻿/, '').trim();
  if (!raw.startsWith('ISA')) return { sender: '', control: '', envelope_errors: ['File does not start with an ISA segment'], orders: [] };
  const el = raw[3];
  const term = raw.length > 105 && !/[A-Za-z0-9 ]/.test(raw[105]) ? raw[105] : '~';
  const segments = raw.split(term).map((s) => s.replace(/[\r\n]/g, '').trim()).filter(Boolean).map((s) => s.split(el));
  const isa = segments[0];
  const sender = (isa[6] || '').trim();
  const control = (isa[13] || '').trim();
  const orders = [];
  const envelope_errors = [];
  let tx = null;
  let received = null;   // GS04 date + GS05 time: when the sender created the group
  for (const seg of segments) {
    const [id, ...e] = seg;
    if (id === 'GS' && /^\d{8}$/.test(e[3] || '') && /^\d{4}/.test(e[4] || '')) {
      received = `${e[3].slice(0, 4)}-${e[3].slice(4, 6)}-${e[3].slice(6, 8)}T${e[4].slice(0, 2)}:${e[4].slice(2, 4)}`;
    }
    if (id === 'ST') {
      if (e[0] !== '850') envelope_errors.push(`Transaction set ${e[0]} is not a purchase order (850)`);
      tx = { txn: e[1], count: 1, order: { client_hint: sender, ship_to: {}, structural_errors: [], ...(received && { received_ts: received }) } };
      continue;
    }
    if (!tx) continue;
    tx.count++;
    const o = tx.order;
    if (id === 'BEG') { o.client_order_ref = e[2]; o.order_date = e[4]; }
    else if (id === 'TD5') o.service = [...e].reverse().find((v) => v && v.trim()) || '';
    else if (id === 'N1' && e[0] === 'ST') o.ship_to.name = e[1] || '';
    else if (id === 'N3') o.ship_to.street = e[0] || '';
    else if (id === 'N4') Object.assign(o.ship_to, { city: e[0] || '', state: e[1] || '', zip: e[2] || '' });
    else if (id === 'PO1') {
      o.quantity = e[1];
      const q = e.findIndex((v) => v === 'VP' || v === 'BP' || v === 'SK');
      o.sku = q >= 0 ? e[q + 1] : '';
    } else if (id === 'DTM' && e[0] === '002') o.requested_date = e[1];
    else if (id === 'SE') {
      if (Number(e[0]) !== tx.count) o.structural_errors.push(`SE segment count ${e[0]} does not match ${tx.count} segments`);
      if (!o.client_order_ref) o.structural_errors.push('BEG segment (PO number) missing');
      if (o.quantity === undefined) o.structural_errors.push('PO1 line item missing');
      orders.push({ ...o, txn: tx.txn, source_ref: `ST ${tx.txn}` });
      tx = null;
    }
  }
  if (tx) envelope_errors.push(`Transaction ${tx.txn} has no SE trailer`);
  return { sender, control, envelope_errors, orders };
}

// 997 functional acknowledgement: A = accepted, E = accepted with errors, R = rejected, per transaction.
export function ack997({ sender, control }, results) {
  const code = (s) => (s === 'rejected' ? 'R' : s === 'held' ? 'E' : 'A');
  const overall = results.every((r) => r.status === 'rejected') ? 'R' : results.some((r) => r.status !== 'accepted' && r.status !== 'corrected') ? 'E' : 'A';
  const segs = [
    `ISA*00*          *00*          *ZZ*HALCYON        *ZZ*${sender.padEnd(15)}*261027*0000*U*00401*${control || '000000000'}*0*P*>`,
    'GS*FA*HALCYON*' + sender + '*20261027*0000*1*X*004010', 'ST*997*0001', 'AK1*PO*1',
    ...results.flatMap((r) => [`AK2*850*${r.txn}`, `AK5*${code(r.status)}`]),
    `AK9*${overall}*${results.length}*${results.length}*${results.filter((r) => r.status !== 'rejected').length}`,
  ];
  segs.push(`SE*${segs.length - 1}*0001`, 'GE*1*1', `IEA*1*${control || '000000000'}`);
  return segs.join('~\n') + '~';
}
