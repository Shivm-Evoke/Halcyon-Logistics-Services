import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool } from './db.js';
import overview from './routes/overview.js';
import operations from './routes/operations.js';
import accounts from './routes/accounts.js';
import ml from './routes/ml.js';
import ingest from './routes/ingest.js';
import agents, { world } from './routes/agents.js';
import { ensureDecisionTable } from './agents/log.js';
import { ensureDatasetTable } from './agents/datasetStore.js';
import { watchInbox } from './ingest/inboxWatcher.js';
import { getContainer } from './container.js';
import { sessionRoutes } from './routes/session.js';
import portal from './routes/portal.js';
import dispatch from './routes/dispatch.js';
import { gate, cachedLookup } from './auth/access.js';
import { SIGNING_KEY } from './auth/key.js';
import { ensureUserTable, userStore } from './auth/users.js';
import { ensureShipmentTable } from './shipments/store.js';

// Sign-ins are signed with JWT_SECRET; without it in production every restart would sign everyone out.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET is not set: every restart signs everyone out');
}

const app = express();
// Azure App Service terminates TLS in front of the app: trust its one hop for the client address (sign-in limits).
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Browsers may not frame the site, guess file types, or send our URLs to other sites.
app.use((_req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "frame-ancestors 'none'" });
  next();
});
// The website and API share one origin in production; cross-origin calls are for local development only.
if (process.env.NODE_ENV !== 'production') app.use(cors());

// A public deployment sets SITE_PASSWORD: the browser asks for it once (any user name).
// The health check and the client API, which has its own token login, stay open.
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const OPEN = /^\/api\/(health$|auth\/|v1\/)/;
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const password = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
    if (OPEN.test(req.path) || same(password, SITE_PASSWORD)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Halcyon", charset="UTF-8"').status(401).send('Password required');
  });
}

app.use(express.json({ limit: '5mb' }));

// Signed-in users only: the portal for customers, every other screen's API for staff (REQUIRE_LOGIN=0 opens the staff area).
const lookup = cachedLookup((id) => userStore.byId(id));
app.use('/api', gate({ key: SIGNING_KEY, requireLogin: process.env.REQUIRE_LOGIN !== '0', lookup }));

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});
app.use('/api', sessionRoutes({ lookup }), portal, dispatch, overview, operations, accounts, ml, ingest, agents);

// In production the API also serves the built website; every screen's path returns the app so deep links work.
const SITE = path.resolve(import.meta.dirname, '../../web/dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(SITE)) {
  app.use(express.static(SITE));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(SITE, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 4000);
// Warm the model before taking traffic so the first request is not slow.
await ensureDecisionTable();
await ensureDatasetTable();
await ensureUserTable();
await ensureShipmentTable();
if (process.env.REQUIRE_LOGIN !== '0' && !(await userStore.list()).some((u) => u.role === 'staff' && u.active)) {
  console.warn('WARNING: no active staff account. Create one with: npm --prefix server run users -- add --email <you> --role staff');
}
const container = await getContainer();
// Load the agents' six months of orders up front, so the first replay or live day does not wait for it.
await world();
// Drop .eml / .edi / C###_*.csv files into the inbox folder to process them (INBOX_WATCH=0 disables).
if (process.env.INBOX_WATCH !== '0') watchInbox(container.ingest);
app.listen(port, () => console.log(`Halcyon API on http://localhost:${port}`));
