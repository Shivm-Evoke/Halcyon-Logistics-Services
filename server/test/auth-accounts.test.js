import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePassword, addAccount, setPassword, setActive, setClient, MIN_PASSWORD } from '../src/auth/accounts.js';

const memoryStore = () => {
  const rows = new Map();
  let id = 0;
  return {
    rows,
    byEmail: async (email) => rows.get(email) ?? null,
    insert: async (u) => { if (rows.has(u.email)) throw Object.assign(new Error('dup'), { code: '23505' }); const r = { id: ++id, active: true, session_version: 0, ...u }; rows.set(u.email, r); return r; },
    update: async (email, patch) => { const r = rows.get(email); if (!r) return null; Object.assign(r, patch); return r; },
  };
};
const deps = (store) => ({ store, clientExists: async (c) => c === 'C055', hash: (s) => `h:${s}` });

test('passwords need at least 12 characters and not just spaces', () => {
  assert.equal(MIN_PASSWORD, 12);
  assert.match(validatePassword('short'), /12 characters/);
  assert.match(validatePassword('            '), /12 characters/);
  assert.equal(validatePassword('long-enough-pass'), null);
});

test('an account is added once, with a lower-case email and a hashed password', async () => {
  const store = memoryStore();
  const u = await addAccount({ email: ' Buyer@C055.test ', role: 'customer', client_id: 'c055', password: 'long-enough-pass' }, deps(store));
  assert.equal(u.email, 'buyer@c055.test');
  assert.equal(u.client_id, 'C055');
  assert.equal(u.password_hash, 'h:long-enough-pass');
  await assert.rejects(addAccount({ email: 'buyer@c055.test', role: 'customer', client_id: 'C055', password: 'long-enough-pass' }, deps(store)), /already exists/);
});

test('bad input is refused with a reason', async () => {
  const d = deps(memoryStore());
  await assert.rejects(addAccount({ email: 'nope', role: 'staff', password: 'long-enough-pass' }, d), /email/);
  await assert.rejects(addAccount({ email: 'a@b.test', role: 'admin', password: 'long-enough-pass' }, d), /role/);
  await assert.rejects(addAccount({ email: 'a@b.test', role: 'customer', password: 'long-enough-pass' }, d), /client/);
  await assert.rejects(addAccount({ email: 'a@b.test', role: 'customer', client_id: 'C999', password: 'long-enough-pass' }, d), /C999/);
  await assert.rejects(addAccount({ email: 'a@b.test', role: 'staff', password: 'short' }, d), /12 characters/);
});

test('a password reset or disable ends existing sign-ins', async () => {
  const store = memoryStore();
  await addAccount({ email: 'ops@h.test', role: 'staff', password: 'long-enough-pass' }, deps(store));
  await setPassword('ops@h.test', 'another-long-pass', deps(store));
  assert.equal(store.rows.get('ops@h.test').password_hash, 'h:another-long-pass');
  assert.equal(store.rows.get('ops@h.test').session_version, 1);
  await setActive('ops@h.test', false, deps(store));
  assert.equal(store.rows.get('ops@h.test').active, false);
  assert.equal(store.rows.get('ops@h.test').session_version, 2);
  await assert.rejects(setActive('ghost@h.test', false, deps(store)), /No account/);
});

test('moving a customer to another client checks the client and ends existing sign-ins', async () => {
  const store = memoryStore();
  const d = { ...deps(store), clientExists: async (c) => ['C055', 'C176'].includes(c) };
  await addAccount({ email: 'buyer@c055.test', role: 'customer', client_id: 'C055', password: 'long-enough-pass' }, d);
  const u = await setClient('Buyer@C055.test', ' c176 ', d);
  assert.equal(u.client_id, 'C176');
  assert.equal(store.rows.get('buyer@c055.test').session_version, 1);
  await assert.rejects(setClient('buyer@c055.test', 'C999', d), /C999 does not exist/);
  await assert.rejects(setClient('buyer@c055.test', '', d), /client/);
  await assert.rejects(setClient('ghost@h.test', 'C176', d), /No account/);
  await addAccount({ email: 'ops@h.test', role: 'staff', password: 'long-enough-pass' }, d);
  await assert.rejects(setClient('ops@h.test', 'C176', d), /customer/);
  assert.equal(store.rows.get('buyer@c055.test').client_id, 'C176');
});
