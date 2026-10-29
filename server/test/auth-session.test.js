import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_COOKIE, SESSION_TTL, shouldRenew, issueSession, readSession, sessionCookie, clearCookie, createRateLimiter } from '../src/auth/session.js';

test('a session round-trips through the cookie and a tampered one reads as signed out', () => {
  const token = issueSession({ id: 7, email: 'a@x.com', role: 'customer', client_id: 'C055', session_version: 2 }, 'k');
  const s = readSession(`x=1; ${SESSION_COOKIE}=${token}`, 'k');
  assert.deepEqual({ id: s.id, ver: s.ver }, { id: 7, ver: 2 });
  assert.equal(s.exp, Math.floor(Date.now() / 1000) + SESSION_TTL);
  assert.equal(readSession(`${SESSION_COOKIE}=${token}x`, 'k'), null);
  assert.equal(readSession(`${SESSION_COOKIE}=${token}`, 'other'), null);
  assert.equal(readSession(undefined, 'k'), null);
});

test('the cookie is HttpOnly, Lax, 7 days, and Secure only when asked', () => {
  assert.match(sessionCookie('t', { secure: false }), /^halcyon_session=t; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/);
  assert.match(sessionCookie('t', { secure: true }), /; Secure$/);
  assert.match(clearCookie({ secure: false }), /Max-Age=0/);
});

test('login attempts are limited per email per window', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.hit('A@x.com'), true);
  assert.equal(rl.hit('a@x.com'), true);
  assert.equal(rl.hit('a@x.com'), false);
  t = 1001;
  assert.equal(rl.hit('a@x.com'), true);
});

test('a client API token is not a website session', async () => {
  const { signToken } = await import('../src/ingest/auth.js');
  const apiToken = signToken({ sub: 'C055', scope: 'orders' }, 'k', 60);
  assert.equal(readSession(`${SESSION_COOKIE}=${apiToken}`, 'k'), null);
});

test('a session carries the account version, and only a matching active account keeps it valid', async () => {
  const { currentUser } = await import('../src/auth/session.js');
  const token = issueSession({ id: 7, email: 'a@x.com', role: 'staff', session_version: 3 }, 'k');
  const s = readSession(`${SESSION_COOKIE}=${token}`, 'k');
  assert.equal(s.ver, 3);
  const lookup = (row) => async () => row;
  assert.equal((await currentUser(s, lookup({ id: 7, email: 'a@x.com', role: 'staff', client_id: null, active: true, session_version: 3 }))).role, 'staff');
  assert.equal(await currentUser(s, lookup({ id: 7, role: 'staff', active: true, session_version: 4 })), null);   // signed out / password reset
  assert.equal(await currentUser(s, lookup({ id: 7, role: 'staff', active: false, session_version: 3 })), null);  // disabled
  assert.equal(await currentUser(s, lookup(null)), null);                                                         // deleted
  // Role and client come from the database, not the token.
  assert.equal((await currentUser(s, lookup({ id: 7, role: 'customer', client_id: 'C010', active: true, session_version: 3 }))).client_id, 'C010');
});

test('sign-in limits count per key, and old windows are cleared', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  assert.equal(rl.hit('ip:1.2.3.4'), true);
  assert.equal(rl.hit('ip:1.2.3.4'), false);
  assert.equal(rl.hit('ip:5.6.7.8'), true);
  t = 5000;
  rl.hit('other');
  assert.equal(rl.size(), 1);
});

test('sessions last 7 days and renew once less than half is left', () => {
  const now = 1_000_000;
  assert.equal(SESSION_TTL, 604800);
  assert.equal(shouldRenew({ exp: now + 604800 }, now), false);
  assert.equal(shouldRenew({ exp: now + 3600 }, now), true);
});

test('the gate renews a session close to expiry and leaves a fresh one alone', async () => {
  const { gate } = await import('../src/auth/access.js');
  const { signToken } = await import('../src/ingest/auth.js');
  const row = { id: 7, email: 'a@x.com', role: 'staff', client_id: null, active: true, session_version: 2 };
  const run = async (ttl) => {
    const token = signToken({ typ: 'session', sub: 7, ver: 2 }, 'k', ttl);
    const headers = {};
    const res = { setHeader: (n, v) => { headers[n] = v; }, status() { return this; }, json() {} };
    await new Promise((resolve) => gate({ key: 'k', requireLogin: true, lookup: async () => row })(
      { headers: { cookie: `${SESSION_COOKIE}=${token}` }, path: '/orders' }, res, resolve));
    return headers['Set-Cookie'];
  };
  assert.match(await run(3600), /^halcyon_session=/);
  assert.equal(await run(6 * 24 * 3600), undefined);
});
