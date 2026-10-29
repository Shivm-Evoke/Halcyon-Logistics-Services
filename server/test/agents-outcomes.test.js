import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutcomeModel, distanceBand } from '../src/agents/outcomes.js';

const clean = { distance_miles: 120, commitment_type: 'standard', cutoff_breach: 0, address_incomplete: 0, stock_miss: 0 };
const many = (n, onTime, extra) => Array.from({ length: n }, (_, i) => ({ ...clean, ...extra, late: i < onTime ? 0 : 1 }));

const rows = [
  ...many(100, 66, { carrier_id: 'D' }),
  ...many(100, 95, { carrier_id: 'A' }),
  ...many(40, 20, { carrier_id: 'A', address_incomplete: 1 }),
  ...many(5, 1, { carrier_id: 'D', commitment_type: 'same_day' }), // too few for its own cell
];
const actualOnTime = (xs) => xs.filter((r) => !r.late).length / xs.length;

test('reproduces the recorded on-time rate when decisions are unchanged', () => {
  const m = OutcomeModel.fromHistory(rows);
  const mean = rows.reduce((s, r) => s + m.pOnTime(r), 0) / rows.length;
  // Sparse cells back off, so the match is close rather than exact.
  assert.ok(Math.abs(mean - actualOnTime(rows)) < 0.01, `${mean} vs ${actualOnTime(rows)}`);
});

test('clean short-haul cells match history', () => {
  const m = OutcomeModel.fromHistory(rows);
  assert.equal(m.pOnTime({ ...clean, carrier_id: 'D' }), 0.66);
  assert.equal(m.pOnTime({ ...clean, carrier_id: 'A' }), 0.95);
  assert.equal(m.pOnTime({ ...clean, carrier_id: 'A', address_incomplete: 1 }), 0.5);
});

test('sparse cells back off to coarser cells instead of returning NaN', () => {
  const m = OutcomeModel.fromHistory(rows);
  // D same-day has 5 rows (< 30): falls back to D <300 with the same flags, any commitment.
  const p = m.pOnTime({ ...clean, carrier_id: 'D', commitment_type: 'same_day' });
  assert.ok(Math.abs(p - 67 / 105) < 1e-9, String(p));
  // An unseen carrier falls back to the band + flags rate.
  const q = m.pOnTime({ ...clean, carrier_id: 'Z' });
  assert.ok(Number.isFinite(q) && q > 0 && q < 1);
  // Nothing at all known for these flags: global rate, still finite.
  assert.ok(Number.isFinite(m.pOnTime({ ...clean, carrier_id: 'Z', stock_miss: 1, distance_miles: 2000 })));
});

test('distanceBand edges', () => {
  assert.equal(distanceBand(299), '<300');
  assert.equal(distanceBand(300), '300-800');
  assert.equal(distanceBand(799), '300-800');
  assert.equal(distanceBand(800), '800+');
});
