// Website sign-in: a signed session token in an HttpOnly cookie, checked against the account in Postgres on use,
// and limits on sign-in attempts.
import { signToken, verifyToken } from '../ingest/auth.js';

export const SESSION_COOKIE = 'halcyon_session';
export const SESSION_TTL = 7 * 24 * 3600;

/** The token names the account and its session version; role and client are read from the database on use. */
export const issueSession = (user, key) => signToken(
  { typ: 'session', sub: user.id, ver: user.session_version ?? 0 }, key, SESSION_TTL,
);

/** @returns { id, ver, exp } from a Cookie header, or null when absent, forged, expired or not a session token. */
export function readSession(cookieHeader, key) {
  const token = String(cookieHeader || '').split(';').map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const p = token && verifyToken(token, key);
  // Client API tokens share the signing key; only website session tokens count here.
  return p?.typ === 'session' ? { id: p.sub, ver: p.ver, exp: p.exp } : null;
}

/** A session with less than half its life left is reissued, so people who keep using the site stay signed in. */
export const shouldRenew = (payload, nowSec) => payload.exp - nowSec < SESSION_TTL / 2;

/**
 * The signed-in account, or null when it was disabled, deleted, or signed out / given a new password since the
 * session began (its session version moved on). lookup(id) returns the account row without its password hash.
 */
export async function currentUser(session, lookup) {
  if (!session) return null;
  const u = await lookup(session.id);
  if (!u || !u.active || u.session_version !== session.ver) return null;
  return { id: u.id, email: u.email, name: u.name ?? null, role: u.role, client_id: u.client_id ?? null };
}

const attrs = (maxAge, secure) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
export const sessionCookie = (token, { secure }) => `${SESSION_COOKIE}=${token}; ${attrs(SESSION_TTL, secure)}`;
export const clearCookie = ({ secure }) => `${SESSION_COOKIE}=; ${attrs(0, secure)}`;

/** hit(key) is false once a key (an email or an address) has used up its attempts in the current window. */
export function createRateLimiter({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const seen = new Map();
  return {
    hit(key) {
      const k = String(key).toLowerCase();
      const t = now();
      for (const [other, w] of seen) if (t - w.start > windowMs) seen.delete(other); // forget finished windows
      const w = seen.get(k);
      if (!w) { seen.set(k, { start: t, n: 1 }); return true; }
      w.n++;
      return w.n <= limit;
    },
    size: () => seen.size,
  };
}
