// Demo accounts come only from environment variables (server/.env locally, Azure App Settings in production).
import { hashSecret } from '../ingest/auth.js';

/** @returns the emails seeded; an account whose variables are unset is skipped. */
export async function seedDemoUsers(env, { store, clientExists, hash = hashSecret, log = console }) {
  const seeded = [];
  const accounts = [
    { email: env.DEMO_CUSTOMER_EMAIL, password: env.DEMO_CUSTOMER_PASSWORD, role: 'customer', client_id: (env.DEMO_CUSTOMER_CLIENT || 'C055').toUpperCase() },
    { email: env.DEMO_STAFF_EMAIL, password: env.DEMO_STAFF_PASSWORD, role: 'staff', client_id: null },
  ];
  for (const a of accounts) {
    if (!a.email || !a.password) continue;
    if (a.client_id && !(await clientExists(a.client_id))) {
      log.warn(`Demo customer not created: client ${a.client_id} does not exist`);
      continue;
    }
    const email = a.email.trim().toLowerCase();
    await store.upsert({ email, name: a.role === 'staff' ? 'Halcyon operations' : null, role: a.role, client_id: a.client_id, password_hash: hash(a.password) });
    seeded.push(email);
  }
  return seeded;
}
