// One signing key for website sessions and client API tokens. Set JWT_SECRET in production;
// a random per-process key means sign-ins end when the server restarts.
import crypto from 'node:crypto';

export const SIGNING_KEY = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
