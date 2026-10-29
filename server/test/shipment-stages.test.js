import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, initialStage, nextStage, stageOf, atRisk } from '../src/shipments/stages.js';

test('orders start in a stage that matches the gateway result', () => {
  assert.equal(initialStage('accepted'), 'received');
  assert.equal(initialStage('corrected'), 'received');
  assert.equal(initialStage('held'), 'on_hold');
  assert.equal(initialStage('rejected'), 'cancelled');
  assert.equal(initialStage('duplicate'), 'cancelled');
});

test('stages only move one step forward and stop at the end, on hold or cancelled', () => {
  assert.deepEqual(STAGES, ['received', 'picked', 'collected', 'in_transit', 'delivered']);
  assert.equal(nextStage('received'), 'picked');
  assert.equal(nextStage('in_transit'), 'delivered');
  for (const s of ['delivered', 'cancelled', 'on_hold', undefined]) assert.equal(nextStage(s), null);
});

test('the current stage is the latest event and risk from 0.4 is at risk', () => {
  assert.equal(stageOf([{ id: 2, stage: 'received', at: '2026-10-29T09:30' }, { id: 1, stage: 'on_hold', at: '2026-10-29T09:00' }]), 'received');
  assert.equal(stageOf([{ id: 1, stage: 'received', at: '2026-10-29T09:00' }, { id: 2, stage: 'picked', at: '2026-10-29T09:00' }]), 'picked');
  assert.equal(stageOf([]), null);
  assert.equal(atRisk(0.4), true);
  assert.equal(atRisk('0.39'), false);
  assert.equal(atRisk(null), false);
});
