// Website sign-in for customers and staff: /api/session (who am I), /login, /logout.
import { Router } from 'express';
import { checkSecret } from '../ingest/auth.js';
import { userStore } from '../auth/users.js';
import { SIGNING_KEY } from '../auth/key.js';
import { issueSession, sessionCookie, clearCookie, createRateLimiter } from '../auth/session.js';

const r = Router();
const limiter = createRateLimiter();
const secure = process.env.NODE_ENV === 'production';
const publicUser = (u) => ({ name: u.name, email: u.email, role: u.role, client_id: u.client_id ?? null });

r.get('/session', (req, res) => (req.user ? res.json(publicUser(req.user)) : res.status(401).json({ error: 'Not signed in' })));

r.post('/session/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password' });
  if (!limiter.hit(email)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (await userStore.count() === 0) return res.status(503).json({ error: 'Sign-in is not set up yet' });
  const user = await userStore.byEmail(email);
  if (!user || !checkSecret(password, user.password_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  await userStore.touch(user.id);
  res.set('Set-Cookie', sessionCookie(issueSession(user, SIGNING_KEY), { secure })).json(publicUser(user));
});

r.post('/session/logout', (_req, res) => res.set('Set-Cookie', clearCookie({ secure })).json({ ok: true }));

export default r;
