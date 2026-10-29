// Website accounts live only in Postgres. These rules are shared by the account tool (scripts/users.mjs) and the tests.
import { hashSecret } from '../ingest/auth.js';

export const MIN_PASSWORD = 12;
const ROLES = ['customer', 'staff'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @returns a reason the password is refused, or null */
export const validatePassword = (p) => (String(p ?? '').trim().length < MIN_PASSWORD ? `Passwords need at least ${MIN_PASSWORD} characters` : null);

const fail = (message) => { throw new Error(message); };
const normalEmail = (e) => String(e ?? '').trim().toLowerCase();

/** deps: { store: { byEmail, insert, update }, clientExists(id), hash? } */
export async function addAccount({ email, role, client_id, name, password }, { store, clientExists, hash = hashSecret }) {
  const e = normalEmail(email);
  if (!EMAIL.test(e)) fail(`"${email}" is not an email address`);
  if (!ROLES.includes(role)) fail(`role must be ${ROLES.join(' or ')}`);
  const client = role === 'customer' ? String(client_id ?? '').trim().toUpperCase() : null;
  if (role === 'customer' && !client) fail('A customer account needs a client (for example C176)');
  if (client && !(await clientExists(client))) fail(`Client ${client} does not exist`);
  const bad = validatePassword(password);
  if (bad) fail(bad);
  if (await store.byEmail(e)) fail(`An account for ${e} already exists`);
  try {
    return await store.insert({ email: e, role, client_id: client, name: name?.trim() || null, password_hash: hash(password) });
  } catch (err) {
    if (err.code === '23505') fail(`An account for ${e} already exists`);
    throw err;
  }
}

async function change(email, patch, store) {
  const current = await store.byEmail(normalEmail(email));
  if (!current) fail(`No account for ${normalEmail(email)}`);
  // A new session version signs the account out everywhere.
  return store.update(current.email, { ...patch, session_version: current.session_version + 1 });
}

export async function setPassword(email, password, { store, hash = hashSecret }) {
  const bad = validatePassword(password);
  if (bad) fail(bad);
  return change(email, { password_hash: hash(password) }, store);
}

export const setActive = (email, active, { store }) => change(email, { active }, store);
