import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeDecide } from '../src/agents/intake.js';
import { DEFAULT_SETTINGS as S } from '../src/agents/settings.js';

const order = { delivery_id: 'D1', address_incomplete: 0, account_tier: 'Tier 2' };
const low = () => 0.1;   // below addressFixRate 0.8
const high = () => 0.95; // above it

test('a complete address needs nothing', () => {
  const d = intakeDecide(order, S, low);
  assert.equal(d.agent, 'intake');
  assert.equal(d.fixAddress, false);
  assert.equal(d.needsApproval, false);
});

test('an incomplete address is completed when the draw falls under the fix rate', () => {
  const d = intakeDecide({ ...order, address_incomplete: 1 }, S, low);
  assert.equal(d.fixAddress, true);
  assert.ok(d.confidence >= S.intakeConfidenceMin);
  assert.equal(d.needsApproval, false);
});

test('otherwise the client is asked and the address stays incomplete', () => {
  const d = intakeDecide({ ...order, address_incomplete: 1 }, S, high);
  assert.equal(d.fixAddress, false);
  assert.match(d.rule, /client query/);
});

test('changing a Tier 1 order needs approval', () => {
  const d = intakeDecide({ ...order, address_incomplete: 1, account_tier: 'Tier 1' }, S, low);
  assert.equal(d.needsApproval, true);
});
