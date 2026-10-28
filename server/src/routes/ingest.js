// Inbound gateway HTTP API.
//   /api/auth/login, /api/v1/orders*  — client-facing, bearer-token authenticated
//   /api/ingest/*                     — internal: email/EDI upload, provider webhook, monitoring
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getContainer } from '../container.js';
import { signToken, verifyToken, checkSecret } from '../ingest/auth.js';
import { apiOrderResult } from '../ingest/reply.js';
import { openApiSpec, docsPage } from '../ingest/openapi.js';

const r = Router();
const TOKEN_TTL = 3600;
const MAX_ORDERS = 500;
// Set JWT_SECRET in production; a random per-process key means tokens end when the server restarts.
const JWT_KEY = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
export const TEST_DATA_DIR = path.resolve(import.meta.dirname, '../../../ingest/test-data');

const rawBody = express.text({ type: ['message/rfc822', 'text/plain', 'application/edi-x12', 'text/csv'], limit: '5mb' });
const content = (req) => (typeof req.body === 'string' ? req.body : req.body?.content || '');
const ref = (id) => `IN-${String(id).padStart(6, '0')}`;
const idFromRef = (s) => Number(String(s).replace(/^IN-0*/, ''));

// ---------- Client API ----------

r.post('/auth/login', async (req, res) => {
  const { client_id: id, client_secret: secret } = req.body || {};
  const { ingestRepo } = await getContainer();
  const client = id && await ingestRepo.getApiClient(String(id).toUpperCase());
  if (!client || !secret || !checkSecret(secret, client.secret_hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Unknown client id or wrong secret' });
  }
  await ingestRepo.touchLogin(client.client_id);
  res.json({ access_token: signToken({ sub: client.client_id, scope: 'orders' }, JWT_KEY, TOKEN_TTL), token_type: 'Bearer', expires_in: TOKEN_TTL });
});

function requireClient(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = token && verifyToken(token, JWT_KEY);
  if (!payload) return res.status(401).json({ error: 'unauthorized', message: 'Missing, invalid or expired bearer token' });
  req.clientId = payload.sub;
  next();
}

r.post('/v1/orders', requireClient, async (req, res) => {
  const body = req.body;
  const orders = Array.isArray(body?.orders) ? body.orders : body && typeof body === 'object' && !Array.isArray(body) && !body.orders ? [body] : null;
  if (!orders || !orders.length) return res.status(400).json({ error: 'invalid_payload', message: 'Send one order object, or { "orders": [ ... ] }' });
  if (orders.length > MAX_ORDERS) return res.status(413).json({ error: 'too_many_orders', message: `At most ${MAX_ORDERS} orders per request` });
  const foreign = orders.find((o) => o.client_id && String(o.client_id).toUpperCase() !== req.clientId);
  if (foreign) return res.status(403).json({ error: 'forbidden', message: `This token can only submit orders for ${req.clientId}` });

  const { ingestRepo, ingest } = await getContainer();
  const key = req.headers['idempotency-key'];
  if (key) {
    const prior = await ingestRepo.getIdempotent(req.clientId, key);
    if (prior) return res.set('Idempotent-Replay', 'true').json(prior.response);
  }
  const result = await ingest.api(req.clientId, orders);
  const response = { message_id: result.message_id, status: result.status, summary: result.summary, orders: result.orders };
  if (key) await ingestRepo.saveIdempotent(req.clientId, key, response);
  res.json(response);
});

r.get('/v1/orders', requireClient, async (req, res) => {
  const { ingestRepo } = await getContainer();
  res.json((await ingestRepo.clientOrders(req.clientId)).map((o) => apiOrderResult({ ...o, ref: ref(o.id), risk: o.risk == null ? null : Number(o.risk) })));
});

async function ownOrder(req, res) {
  const { ingestRepo } = await getContainer();
  const o = await ingestRepo.getOrder(idFromRef(req.params.ref));
  if (!o || o.client_id !== req.clientId) { res.status(404).json({ error: 'not_found', message: `No order ${req.params.ref} for ${req.clientId}` }); return null; }
  return o;
}

r.get('/v1/orders/:ref', requireClient, async (req, res) => {
  const o = await ownOrder(req, res);
  if (o) res.json(apiOrderResult({ ...o, ref: ref(o.id), risk: o.risk == null ? null : Number(o.risk) }));
});

// Correct a held order (address, SKU, quantity or service); it is re-validated and released if clean.
r.patch('/v1/orders/:ref', requireClient, async (req, res) => {
  const o = await ownOrder(req, res);
  if (!o) return;
  if (!['held', 'corrected', 'accepted'].includes(o.status)) return res.status(409).json({ error: 'not_editable', message: `Order is ${o.status}` });
  res.json(apiOrderResult(await (await getContainer()).ingest.reprocess(o.id, req.body || {})));
});

// ---------- Internal: channels and monitoring ----------

r.post('/ingest/email', rawBody, async (req, res) => {
  if (!content(req).trim()) return res.status(400).json({ error: 'Empty email' });
  res.json(await (await getContainer()).ingest.email(content(req), { filename: req.body?.filename }));
});

// Email-provider inbound webhook (already parsed): { from, subject, date, text, attachments: [{ filename, content }] }.
r.post('/ingest/email/inbound', async (req, res) => {
  if (!req.body?.from) return res.status(400).json({ error: 'from is required' });
  res.json(await (await getContainer()).ingest.parsedEmail(req.body));
});

r.post('/ingest/edi', rawBody, async (req, res) => {
  if (!content(req).trim()) return res.status(400).json({ error: 'Empty EDI file' });
  res.json(await (await getContainer()).ingest.edi(content(req), { filename: req.body?.filename }));
});

r.post('/ingest/file', rawBody, async (req, res) => {
  const filename = req.body?.filename || req.query.filename;
  if (!filename) return res.status(400).json({ error: 'filename is required (e.g. C055_orders.csv)' });
  res.json(await (await getContainer()).ingest.csvFile(content(req), { filename }));
});

r.get('/ingest/messages', async (_req, res) => res.json(await (await getContainer()).ingestRepo.listMessages()));

r.get('/ingest/messages/:id', async (req, res) => {
  const m = await (await getContainer()).ingestRepo.getMessage(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Message not found' });
  res.json({ ...m, orders: m.orders.map((o) => ({ ...o, ref: ref(o.id) })) });
});

r.patch('/ingest/orders/:id', async (req, res) => {
  const result = await (await getContainer()).ingest.reprocess(Number(req.params.id), req.body || {});
  if (!result) return res.status(404).json({ error: 'Order not found' });
  res.json(apiOrderResult(result));
});

r.get('/ingest/stats', async (_req, res) => res.json(await (await getContainer()).ingestRepo.stats()));

// Generated test files, so the UI can send them without a file picker.
r.get('/ingest/test-files', (_req, res) => {
  const list = (dir) => (fs.existsSync(path.join(TEST_DATA_DIR, dir)) ? fs.readdirSync(path.join(TEST_DATA_DIR, dir)).filter((f) => !f.startsWith('.')).sort() : []);
  res.json({ email: list('email'), edi: list('edi'), api: list('api'), files: list('files') });
});

r.get('/ingest/test-files/:dir/:name', (req, res) => {
  if (!['email', 'edi', 'api', 'files'].includes(req.params.dir) || !/^[\w.-]+$/.test(req.params.name)) return res.status(400).json({ error: 'Bad path' });
  const file = path.join(TEST_DATA_DIR, req.params.dir, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No such test file' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

// Result of the synthetic live week (ingest/run-live-week.mjs), scored against its ground truth.
const LIVE_WEEK_DIR = path.resolve(TEST_DATA_DIR, '../live-week');
r.get('/ingest/live-week', (_req, res) => {
  const file = path.join(LIVE_WEEK_DIR, 'report.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not run yet: npm run demo:week' });
  const manifest = JSON.parse(fs.readFileSync(path.join(LIVE_WEEK_DIR, 'manifest.json'), 'utf8'));
  res.json({ ...JSON.parse(fs.readFileSync(file, 'utf8')), injected: manifest.injected, seed: manifest.seed });
});

// ---------- API documentation ----------

r.get('/openapi.json', (_req, res) => res.json(openApiSpec));
r.get('/docs', (_req, res) => res.type('html').send(docsPage));

export default r;
