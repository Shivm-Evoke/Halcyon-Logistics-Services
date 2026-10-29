// Website sign-in for customers and staff: /api/session (who am I), /login, /logout.
import { Router } from 'express';
import { checkSecret, hashSecret } from '../ingest/auth.js';
import { userStore } from '../auth/users.js';
import { SIGNING_KEY } from '../auth/key.js';
import { issueSession, sessionCookie, clearCookie, createRateLimiter } from '../auth/session.js';

/** lookup: the cached account lookup the gate uses, so signing out takes effect at once. */
export function sessionRoutes({ lookup }) {
  const r = Router();
  const perEmail = createRateLimiter({ limit: 10 });
  const perAddress = createRateLimiter({ limit: 30 });
  const secure = process.env.NODE_ENV === 'production';
  // Checked when the email is unknown, so a wrong email takes as long as a wrong password.
  const DECOY = hashSecret('decoy-password-never-used');
  const publicUser = (u) => ({ name: u.name ?? null, email: u.email, role: u.role, client_id: u.client_id ?? null });

  r.get('/session', (req, res) => (req.user ? res.json(publicUser(req.user)) : res.status(401).json({ error: 'Not signed in' })));

  r.post('/session/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'Enter your email and password' });
    }
    if (!perAddress.hit(`ip:${req.ip}`) || !perEmail.hit(email.trim())) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const user = await userStore.byEmail(email);
    const ok = checkSecret(password, user?.password_hash ?? DECOY) && user?.active;
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
    await userStore.touch(user.id);
    res.set('Set-Cookie', sessionCookie(issueSession(user, SIGNING_KEY), { secure })).json(publicUser(user));
  });

  // Ends this account's sessions everywhere, not only in this browser.
  r.post('/session/logout', async (req, res) => {
    if (req.user) { await userStore.bumpSession(req.user.id); lookup.forget(req.user.id); }
    res.set('Set-Cookie', clearCookie({ secure })).json({ ok: true });
  });

  return r;
}
