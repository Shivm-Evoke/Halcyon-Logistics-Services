import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFor, cachedLookup } from '../src/auth/access.js';

const C = { role: 'customer', client_id: 'C055' };
const S = { role: 'staff' };
const on = { requireLogin: true };

test('public routes need no session', () => {
  for (const p of ['/health', '/session/login', '/session', '/auth/login', '/v1/orders', '/v1/orders/IN-000001', '/openapi.json', '/docs']) {
    assert.equal(accessFor(p, null, on), 'ok', p);
  }
});

test('portal is customers only and everything else is staff only', () => {
  assert.equal(accessFor('/portal/orders', null, on), 401);
  assert.equal(accessFor('/portal/orders', C, on), 'ok');
  assert.equal(accessFor('/portal/orders', S, on), 403);
  assert.equal(accessFor('/agents/datasets', C, on), 403);
  assert.equal(accessFor('/agents/datasets', S, on), 'ok');
  assert.equal(accessFor('/dispatch', null, on), 401);
  assert.equal(accessFor('/sessionx', null, on), 401);
});

test('with login switched off the staff area is open but the portal still needs a customer', () => {
  assert.equal(accessFor('/agents/datasets', null, { requireLogin: false }), 'ok');
  assert.equal(accessFor('/portal/orders', null, { requireLogin: false }), 401);
});

test('the email provider webhook stays open and paths match whatever their case', () => {
  assert.equal(accessFor('/ingest/email/inbound', null, on), 'ok');
  assert.equal(accessFor('/ingest/email', null, on), 401);
  assert.equal(accessFor('/PORTAL/orders', { role: 'staff' }, on), 403);
  assert.equal(accessFor('/Portal/orders', null, { requireLogin: false }), 401);
});

test('account lookups are cached for a few seconds and can be forgotten', async () => {
  let t = 0, calls = 0;
  const get = cachedLookup(async (id) => { calls++; return { id }; }, { ttlMs: 5000, now: () => t });
  await get(1); await get(1);
  assert.equal(calls, 1);
  t = 6000; await get(1);
  assert.equal(calls, 2);
  get.forget(1); await get(1);
  assert.equal(calls, 3);
});
