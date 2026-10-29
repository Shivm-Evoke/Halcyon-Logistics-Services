import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_COOKIE, issueSession, readSession, sessionCookie, clearCookie, createRateLimiter } from '../src/auth/session.js';

test('a session round-trips through the cookie and a tampered one reads as signed out', () => {
  const token = issueSession({ id: 7, email: 'a@x.com', name: 'Ann', role: 'customer', client_id: 'C055' }, 'k');
  assert.deepEqual(readSession(`x=1; ${SESSION_COOKIE}=${token}`, 'k'), { id: 7, email: 'a@x.com', name: 'Ann', role: 'customer', client_id: 'C055' });
  assert.equal(readSession(`${SESSION_COOKIE}=${token}x`, 'k'), null);
  assert.equal(readSession(`${SESSION_COOKIE}=${token}`, 'other'), null);
  assert.equal(readSession(undefined, 'k'), null);
});

test('the cookie is HttpOnly, Lax, 8 hours, and Secure only when asked', () => {
  assert.match(sessionCookie('t', { secure: false }), /^halcyon_session=t; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800$/);
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
