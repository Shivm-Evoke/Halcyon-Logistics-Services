import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemoUsers } from '../src/auth/seed.js';

const memoryStore = () => {
  const rows = new Map();
  let id = 0;
  return {
    byEmail: async (email) => rows.get(email) ?? null,
    upsert: async (u) => { const row = { ...(rows.get(u.email) || { id: ++id }), ...u }; rows.set(u.email, row); return row; },
    touch: async () => {},
  };
};
const hash = (s) => `h:${s}`;
const quiet = { warn: () => {} };

test('unset variables seed nobody', async () => {
  assert.deepEqual(await seedDemoUsers({}, { store: memoryStore(), clientExists: async () => true, log: quiet }), []);
});

test('both demo accounts are seeded, emails lower-cased, and re-seeding replaces the hash', async () => {
  const store = memoryStore();
  const env = { DEMO_CUSTOMER_EMAIL: 'Buyer@C055.test', DEMO_CUSTOMER_PASSWORD: 'p1', DEMO_STAFF_EMAIL: 'ops@halcyon.test', DEMO_STAFF_PASSWORD: 'p2' };
  assert.deepEqual(await seedDemoUsers(env, { store, clientExists: async () => true, hash, log: quiet }), ['buyer@c055.test', 'ops@halcyon.test']);
  const buyer = await store.byEmail('buyer@c055.test');
  assert.equal(buyer.client_id, 'C055');
  assert.equal(buyer.role, 'customer');
  assert.equal((await store.byEmail('ops@halcyon.test')).role, 'staff');
  await seedDemoUsers({ ...env, DEMO_STAFF_PASSWORD: 'p3' }, { store, clientExists: async () => true, hash, log: quiet });
  assert.equal((await store.byEmail('ops@halcyon.test')).password_hash, 'h:p3');
});

test('a customer for an unknown client is skipped with a warning', async () => {
  const warned = [];
  const store = memoryStore();
  await seedDemoUsers({ DEMO_CUSTOMER_EMAIL: 'b@x.test', DEMO_CUSTOMER_PASSWORD: 'p', DEMO_CUSTOMER_CLIENT: 'C999' },
    { store, clientExists: async () => false, hash, log: { warn: (m) => warned.push(m) } });
  assert.equal(await store.byEmail('b@x.test'), null);
  assert.match(warned[0], /C999/);
});
