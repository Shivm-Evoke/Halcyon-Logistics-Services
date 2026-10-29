// Unit tests for the desk's pure ops-clock and stage-timing functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clockNow, runIdOf, nextEvent, dueStage } from '../src/desk/clock.js';

test('clockNow advances set_to by the real time since set_at', () => {
  const setAt = new Date('2026-01-01T10:00:00Z');
  const row = { set_to: '2026-09-25 09:15', set_at: setAt };
  assert.equal(clockNow(row, new Date(setAt.getTime() + 10 * 60000)), '2026-09-25 09:25');
});

test('clockNow accepts a Date set_to and defaults when there is no row', () => {
  const setAt = new Date('2026-01-01T10:00:00Z');
  assert.equal(clockNow({ set_to: new Date('2026-09-25T09:15:00'), set_at: setAt }, setAt), '2026-09-25 09:15');
  assert.equal(clockNow(null, setAt), '2026-09-25 09:15');
});

test('runIdOf names the run by day and number', () => {
  assert.equal(runIdOf({ set_to: '2026-09-25 07:30', run_no: 3 }), 'desk-2026-09-25-3');
  assert.equal(runIdOf({ set_to: '2026-09-26 08:00', run_from: '2026-09-25 07:30', run_no: 3 }), 'desk-2026-09-25-3');
});

test('nextEvent finds the next checkpoint, rolling to the next morning', () => {
  assert.equal(nextEvent('2026-09-25 09:15'), '2026-09-25 13:00');
  assert.equal(nextEvent('2026-09-25 07:00'), '2026-09-25 08:00');
  assert.equal(nextEvent('2026-09-25 13:00'), '2026-09-25 14:00');
  assert.equal(nextEvent('2026-09-25 23:59'), '2026-09-26 08:00');
});

const wave2 = { stage: 'received', wave: 2, commitment_type: 'same_day', promised_date: '2026-09-25', received_ts: '2026-09-25 10:30' };

test('dueStage moves a wave 2 order through the day', () => {
  assert.equal(dueStage(wave2, '2026-09-25 12:59'), 'received');
  assert.equal(dueStage(wave2, '2026-09-25 13:00'), 'picked');
  assert.equal(dueStage(wave2, '2026-09-25 14:00'), 'collected');
  assert.equal(dueStage(wave2, '2026-09-25 23:59'), 'delivered');
});

test('dueStage picks wave 1 at 08:00 and later orders the day after', () => {
  const w1 = { ...wave2, wave: 1, received_ts: '2026-09-25 07:00', promised_date: '2026-09-27' };
  assert.equal(dueStage(w1, '2026-09-25 08:00'), 'picked');
  assert.equal(dueStage(w1, '2026-09-25 23:59'), 'in_transit');
  const std = { stage: 'received', wave: null, commitment_type: 'standard', promised_date: '2026-09-28', received_ts: '2026-09-25 10:30' };
  assert.equal(dueStage(std, '2026-09-25 23:59'), 'received');
  assert.equal(dueStage(std, '2026-09-26 08:00'), 'picked');
});

test('dueStage never delivers an order before it is picked and collected', () => {
  // Same-day, received after the 08:00 cutoff with no second wave: picked the next morning, so delivered no earlier
  // than the end of that day, never on the night it was received.
  const late = { stage: 'received', wave: null, commitment_type: 'same_day', promised_date: '2026-09-25', received_ts: '2026-09-25 09:15' };
  assert.equal(dueStage(late, '2026-09-25 23:59'), 'received');
  assert.equal(dueStage(late, '2026-09-26 08:00'), 'picked');
  assert.equal(dueStage(late, '2026-09-26 14:00'), 'collected');
  assert.equal(dueStage(late, '2026-09-26 15:00'), 'in_transit');
  assert.equal(dueStage(late, '2026-09-26 23:59'), 'delivered');
});

test('dueStage never moves held or cancelled orders, nor backwards', () => {
  assert.equal(dueStage({ ...wave2, stage: 'on_hold' }, '2026-09-25 23:59'), 'on_hold');
  assert.equal(dueStage({ ...wave2, stage: 'cancelled' }, '2026-09-25 23:59'), 'cancelled');
  assert.equal(dueStage({ ...wave2, stage: 'collected' }, '2026-09-25 13:00'), 'collected');
});
