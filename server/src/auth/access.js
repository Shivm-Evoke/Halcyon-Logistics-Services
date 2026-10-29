// Who may call which API: public routes, the customer portal, and everything else for Halcyon staff.
import { readSession, currentUser } from './session.js';

// The client API (/auth, /v1) has its own bearer-token login; /session is how the website signs in.
// The email provider's inbound webhook was open before sign-in existed and stays open.
const PUBLIC = /^\/(health|openapi\.json|docs|session|session\/.*|auth\/.*|v1(\/.*)?|ingest\/email\/inbound)$/i;
const PORTAL = /^\/portal(\/|$)/i;

/** @param path relative to /api; @returns 'ok', 401 (sign in) or 403 (wrong role) */
export function accessFor(path, user, { requireLogin }) {
  if (PUBLIC.test(path)) return 'ok';
  if (PORTAL.test(path)) return !user ? 401 : user.role === 'customer' && user.client_id ? 'ok' : 403;
  if (!requireLogin) return 'ok';
  return !user ? 401 : user.role === 'staff' ? 'ok' : 403;
}

/** Account lookups are kept a few seconds, so a busy screen does not query the database on every call. */
export function cachedLookup(lookup, { ttlMs = 5000, now = Date.now } = {}) {
  const cache = new Map();
  const get = async (id) => {
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttlMs) return hit.row;
    const row = await lookup(id);
    cache.set(id, { row, at: now() });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return row;
  };
  get.forget = (id) => cache.delete(id);
  return get;
}

/** Express middleware for /api: sets req.user from the session cookie and the account, then enforces accessFor. */
export const gate = ({ key, requireLogin, lookup }) => async (req, res, next) => {
  try {
    req.user = await currentUser(readSession(req.headers.cookie, key), lookup);
    const verdict = accessFor(req.path, req.user, { requireLogin });
    if (verdict === 'ok') return next();
    res.status(verdict).json({ error: verdict === 401 ? 'Sign in required' : 'Not allowed' });
  } catch (e) { next(e); }
};
