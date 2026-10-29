// Website accounts: customers (one client each) and Halcyon staff.
import { q, one } from '../db.js';

export const ensureUserTable = () => q(`
  CREATE TABLE IF NOT EXISTS users (
    id             serial PRIMARY KEY,
    email          text NOT NULL UNIQUE,
    password_hash  text NOT NULL,
    role           text NOT NULL CHECK (role IN ('customer', 'staff')),
    client_id      text REFERENCES clients,
    name           text,
    created_at     timestamp NOT NULL DEFAULT now(),
    last_login_at  timestamp,
    CHECK (role = 'staff' OR client_id IS NOT NULL)
  )`);

export const userStore = {
  byEmail: (email) => one('SELECT * FROM users WHERE email = $1', [String(email).trim().toLowerCase()]),
  upsert: ({ email, name, role, client_id, password_hash }) => one(
    `INSERT INTO users (email, name, role, client_id, password_hash) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, client_id = EXCLUDED.client_id, password_hash = EXCLUDED.password_hash
     RETURNING *`, [email, name, role, client_id, password_hash]),
  touch: (id) => q('UPDATE users SET last_login_at = now() WHERE id = $1', [id]),
  count: async () => Number((await one('SELECT count(*) AS n FROM users')).n),
};

export const clientExists = async (id) => Boolean(await one('SELECT 1 FROM clients WHERE client_id = $1', [id]));
