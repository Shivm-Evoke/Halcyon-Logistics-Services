// Website accounts in Postgres: customers (one client each) and Halcyon staff. Created only with the account tool.
import { q, one } from '../db.js';

// Columns added after the first release are added in place, so an existing database keeps its accounts.
export const ensureUserTable = async () => {
  await q(`
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
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0');
};

const PUBLIC_COLUMNS = 'id, email, role, client_id, name, active, session_version, created_at, last_login_at';

export const userStore = {
  byEmail: (email) => one('SELECT * FROM users WHERE email = $1', [String(email).trim().toLowerCase()]),
  /** What a session check needs: never the password hash. */
  byId: (id) => one('SELECT id, email, role, client_id, name, active, session_version FROM users WHERE id = $1', [id]),
  insert: ({ email, role, client_id, name, password_hash }) => one(
    `INSERT INTO users (email, role, client_id, name, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_COLUMNS}`,
    [email, role, client_id, name, password_hash]),
  update: (email, patch) => {
    const keys = Object.keys(patch).filter((k) => ['password_hash', 'active', 'session_version', 'name', 'client_id'].includes(k));
    return one(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE email = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [email, ...keys.map((k) => patch[k])]);
  },
  /** Signing out ends every session of the account. */
  bumpSession: (id) => q('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [id]),
  list: () => q(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY role, email`),
  touch: (id) => q('UPDATE users SET last_login_at = now() WHERE id = $1', [id]),
};

export const clientExists = async (id) => Boolean(await one('SELECT 1 FROM clients WHERE client_id = $1', [id]));
