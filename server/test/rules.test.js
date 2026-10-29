import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEmailOrder, validateAddress, promiseDelivery, rankCarriers, whatIf,
} from '../src/rules.js';

const EMAIL = `From: orders@client055.example
Subject: PO 88213 - urgent

Hi team, please send the following.
Account: C055
SKU: HX-2201   Qty: 40
Service: same day
Ship to: Dana Ortiz
Address: 418 Harbor Street
City: Hartford
State: CT
ZIP: 06103
Thanks`;

test('parses a labelled email order', () => {
  const o = parseEmailOrder(EMAIL);
  assert.equal(o.client_id, 'C055');
  assert.equal(o.sku, 'HX-2201');
  assert.equal(o.quantity, 40);
  assert.equal(o.commitment_type, 'same_day');
  assert.deepEqual(o.ship_to, { name: 'Dana Ortiz', street: '418 Harbor Street', city: 'Hartford', state: 'CT', zip: '06103' });
});

test('parses a one-line address with alternate labels', () => {
  const o = parseEmailOrder('Customer C022\nItem HX-9 x 5\nNext day please\nDeliver to: Sam Lee, 77 Oak Ave, Columbus, OH 43215');
  assert.equal(o.client_id, 'C022');
  assert.equal(o.commitment_type, 'next_day');
  assert.equal(o.quantity, 5);
  assert.deepEqual(o.ship_to, { name: 'Sam Lee', street: '77 Oak Ave', city: 'Columbus', state: 'OH', zip: '43215' });
});

test('complete address validates and maps to a region', () => {
  const v = validateAddress({ name: 'A', street: '1 Main St', city: 'Hartford', state: 'CT', zip: '06103' });
  assert.deepEqual(v.issues, []);
  assert.equal(v.region, 'Northeast');
});

test('flags missing fields, missing house number and ZIP/state mismatch', () => {
  const v = validateAddress({ name: 'A', street: 'Harbor Street', city: '', state: 'CT', zip: '94105' });
  assert.ok(v.issues.includes('City is missing'));
  assert.ok(v.issues.some(i => i.includes('house number')));
  assert.ok(v.issues.some(i => i.includes('does not match state')));
});

test('same-day before the 8am cutoff keeps its promise', () => {
  const p = promiseDelivery({ receivedTs: '2026-10-27T07:30', commitmentType: 'same_day' });
  assert.equal(p.pickListDate, '2026-10-27');
  assert.equal(p.promisedDate, '2026-10-28');
  assert.equal(p.afterCutoff, false);
});

test('same-day after the cutoff is not promised as same-day', () => {
  const p = promiseDelivery({ receivedTs: '2026-10-27T10:15', commitmentType: 'same_day' });
  assert.equal(p.afterCutoff, true);
  assert.equal(p.pickListDate, '2026-10-28');
  assert.equal(p.promisedDate, '2026-10-29');
  assert.equal(p.offeredCommitment, 'next_day');
});

test('same-day after 08:00 keeps same-day on the second wave when the warehouse has room', () => {
  const p = promiseDelivery({ receivedTs: '2026-10-27T10:15', commitmentType: 'same_day', secondWaveAt: '13:00', wave2Room: true });
  assert.equal(p.offeredCommitment, 'same_day');
  assert.equal(p.wave, 2);
  assert.equal(p.pickListDate, '2026-10-27');
  assert.equal(p.promisedDate, '2026-10-28');
});

test('same-day after 08:00 is re-promised next-day when the second wave is full or already gone', () => {
  const full = promiseDelivery({ receivedTs: '2026-10-27T10:15', commitmentType: 'same_day', secondWaveAt: '13:00', wave2Room: false });
  const late = promiseDelivery({ receivedTs: '2026-10-27T13:05', commitmentType: 'same_day', secondWaveAt: '13:00', wave2Room: true });
  for (const p of [full, late]) {
    assert.equal(p.offeredCommitment, 'next_day');
    assert.equal(p.wave, 'next');
  }
});

test('without a second wave the promise rule is unchanged', () => {
  const p = promiseDelivery({ receivedTs: '2026-10-27T10:15', commitmentType: 'same_day' });
  assert.equal(p.offeredCommitment, 'next_day');
  assert.equal(p.wave, 'next');
  assert.equal(promiseDelivery({ receivedTs: '2026-10-27T07:30', commitmentType: 'same_day' }).wave, 1);
});

test('carrier ranking uses expected cost including late cost', () => {
  const stats = [
    { carrier_id: 'A', avg_rate: 16.7, clean_late_rate: 0.05, has_api: 'Y' },
    { carrier_id: 'D', avg_rate: 13.5, clean_late_rate: 0.34, has_api: 'N' },
  ];
  const r = rankCarriers(stats, { slaClient: true, commitmentType: 'next_day' });
  assert.equal(r[0].carrier_id, 'A');
  assert.equal(r[1].eligible, false);
});

test('what-if returns baseline when nothing is fixed and improves when fixes apply', () => {
  const groups = [
    { f_address: false, f_cutoff: false, f_stock: false, has_api: true, n: 100, late: 5, penalties: 0, redelivery: 0 },
    { f_address: true, f_cutoff: false, f_stock: false, has_api: true, n: 100, late: 60, penalties: 0, redelivery: 0 },
  ];
  assert.equal(whatIf(groups, {}).onTimeRate, 135 / 200);
  assert.equal(whatIf(groups, { address: true }).onTimeRate, 190 / 200);
});

test('routing alone only removes residual lateness on clean API-tracked orders', () => {
  const groups = [
    { f_address: false, f_cutoff: false, f_stock: false, has_api: true, n: 100, late: 5, penalties: 0, redelivery: 0 },
    { f_address: false, f_cutoff: false, f_stock: false, has_api: false, n: 100, late: 25, penalties: 0, redelivery: 0 },
    { f_address: true, f_cutoff: false, f_stock: false, has_api: true, n: 100, late: 60, penalties: 0, redelivery: 0 },
  ];
  assert.equal(whatIf(groups, { routing: true }).late, 85);
});
