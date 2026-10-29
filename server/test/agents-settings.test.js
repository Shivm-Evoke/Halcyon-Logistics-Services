import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings } from '../src/agents/settings.js';

test('defaults are valid and returned whole', () => {
  const r = validateSettings({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.secondWaveAt, '13:00');
  assert.equal(DEFAULT_SETTINGS.wave2CapacityPerWarehouse, 30);
});

test('a partial override merges over the defaults, including one agent switch', () => {
  const r = validateSettings({ costCapUsd: 9, agents: { stock: false } });
  assert.equal(r.ok, true);
  assert.equal(r.settings.costCapUsd, 9);
  assert.equal(r.settings.agents.stock, false);
  assert.equal(r.settings.agents.carrier, true);
});

test('the second wave must fall after the 08:00 pick list and before 14:00 collection', () => {
  assert.deepEqual(pick(validateSettings({ secondWaveAt: '07:30' })), { ok: false, field: 'secondWaveAt' });
  assert.deepEqual(pick(validateSettings({ secondWaveAt: '14:00' })), { ok: false, field: 'secondWaveAt' });
  assert.deepEqual(pick(validateSettings({ secondWaveAt: '11h30' })), { ok: false, field: 'secondWaveAt' });
  assert.equal(validateSettings({ secondWaveAt: '13:59' }).ok, true);
});

test('numbers out of range name their field', () => {
  assert.deepEqual(pick(validateSettings({ wave2CapacityPerWarehouse: -1 })), { ok: false, field: 'wave2CapacityPerWarehouse' });
  assert.deepEqual(pick(validateSettings({ addressFixRate: 1.2 })), { ok: false, field: 'addressFixRate' });
  assert.deepEqual(pick(validateSettings({ costCapUsd: 'lots' })), { ok: false, field: 'costCapUsd' });
  assert.ok(validateSettings({ addressFixRate: 1.2 }).message.length > 0);
});

test('unknown agent keys are ignored', () => {
  const r = validateSettings({ agents: { teleport: true } });
  assert.equal(r.ok, true);
  assert.equal('teleport' in r.settings.agents, false);
});

function pick({ ok, field }) { return { ok, field }; }
