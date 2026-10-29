// Website sign-in: a signed session token in an HttpOnly cookie, and a per-email limit on login attempts.
import { signToken, verifyToken } from '../ingest/auth.js';

export const SESSION_COOKIE = 'halcyon_session';
export const SESSION_TTL = 8 * 3600;

export const issueSession = (user, key) => signToken(
  { sub: user.id, email: user.email, name: user.name, role: user.role, client_id: user.client_id ?? null }, key, SESSION_TTL,
);

/** @returns the signed-in user from a Cookie header, or null when absent, forged or expired. */
export function readSession(cookieHeader, key) {
  const token = String(cookieHeader || '').split(';').map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const p = token && verifyToken(token, key);
  return p ? { id: p.sub, email: p.email, name: p.name, role: p.role, client_id: p.client_id } : null;
}

const attrs = (maxAge, secure) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
export const sessionCookie = (token, { secure }) => `${SESSION_COOKIE}=${token}; ${attrs(SESSION_TTL, secure)}`;
export const clearCookie = ({ secure }) => `${SESSION_COOKIE}=; ${attrs(0, secure)}`;

/** hit(email) is false once an email has used up its attempts in the current window. */
export function createRateLimiter({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const seen = new Map();
  return {
    hit(email) {
      const k = String(email).toLowerCase();
      const t = now();
      const w = seen.get(k);
      if (!w || t - w.start > windowMs) { seen.set(k, { start: t, n: 1 }); return true; }
      w.n++;
      return w.n <= limit;
    },
  };
}
