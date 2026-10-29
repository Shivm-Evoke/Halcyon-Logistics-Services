// Who may call which API: public routes, the customer portal, and everything else for Halcyon staff.
import { readSession } from './session.js';

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

/** Express middleware for /api: sets req.user from the session cookie and enforces accessFor. */
export const gate = ({ key, requireLogin }) => (req, res, next) => {
  req.user = readSession(req.headers.cookie, key);
  const verdict = accessFor(req.path, req.user, { requireLogin });
  if (verdict === 'ok') return next();
  res.status(verdict).json({ error: verdict === 401 ? 'Sign in required' : 'Not allowed' });
};
