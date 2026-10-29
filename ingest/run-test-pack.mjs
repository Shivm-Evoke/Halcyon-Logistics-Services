// Sends the whole test pack through the live gateway and checks every outcome against expected.json.
//   node ingest/run-test-pack.mjs            (API_URL defaults to http://localhost:4000/api)
//   SITE_PASSWORD=... when the deployment is password-protected
//   STAFF_EMAIL=... STAFF_PASSWORD=... to sign in as staff when the internal gateway routes need it
// PO numbers get a per-run prefix so the pack can be run repeatedly without tripping duplicate detection.
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.API_URL || 'http://localhost:4000/api';
const SITE = process.env.SITE_PASSWORD && { authorization: `Basic ${Buffer.from(`halcyon:${process.env.SITE_PASSWORD}`).toString('base64')}` };
// A staff session cookie for the internal routes (/api/ingest/*) when the site requires sign-in.
const STAFF = process.env.STAFF_EMAIL && await (async () => {
  const res = await fetch(`${API}/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.STAFF_EMAIL, password: process.env.STAFF_PASSWORD }) });
  if (!res.ok) throw new Error(`Staff sign-in failed: ${res.status}`);
  return { cookie: res.headers.get('set-cookie').split(';')[0] };
})();
const DIR = path.join(import.meta.dirname, 'test-data');
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const creds = JSON.parse(fs.readFileSync(path.join(DIR, 'credentials.json'), 'utf8'));
const run = Date.now().toString(36).slice(-5).toUpperCase();
const tag = (s) => s.replaceAll('TP-', `TP${run}-`);
const read = (f) => tag(fs.readFileSync(path.join(DIR, f), 'utf8'));

async function call(method, url, { body, token, headers = {} } = {}) {
  const res = await fetch(`${API}${url}`, {
    method, headers: { 'content-type': 'application/json', ...SITE, ...STAFF, ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

const rows = [];
let failures = 0;
const check = (name, ok, detail = '') => { rows.push({ name, ok, detail }); if (!ok) failures++; };

function compare(file, orders) {
  const exp = expected[file];
  if (!Array.isArray(orders) || orders.length !== exp.length) {
    return check(file, false, `expected ${exp.length} order(s), got ${orders?.length ?? 'none'}`);
  }
  exp.forEach((e, i) => {
    const o = orders[i];
    const codes = o.issues.map((x) => x.code);
    const fixed = o.corrections.map((c) => c.field);
    const missing = [...(e.codes || []).filter((c) => !codes.includes(c)), ...(e.corrected || []).filter((f) => !fixed.includes(f))];
    const ok = o.status === e.status && !missing.length;
    check(`${file} #${i + 1}`, ok, `${o.status}${codes.length ? ` [${codes.join(', ')}]` : ''}${o.late_risk != null ? ` risk ${Math.round(o.late_risk * 100)}%` : ''}${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
  });
}

// Authentication
check('auth: no token is refused', (await call('POST', '/v1/orders', { body: {} })).status === 401);
check('auth: wrong secret is refused', (await call('POST', '/auth/login', { body: { client_id: 'C055', client_secret: 'nope' } })).status === 401);
const login = await call('POST', '/auth/login', { body: { client_id: 'C055', client_secret: creds.C055 } });
check('auth: C055 logs in', login.status === 200 && login.json?.access_token, `token expires in ${login.json?.expires_in}s`);
const token = login.json?.access_token;

// API
for (const f of Object.keys(expected).filter((k) => k.startsWith('api/'))) {
  const r = await call('POST', '/v1/orders', { token, body: read(f) });
  if (expected[f].http) check(f, r.status === expected[f].http, `HTTP ${r.status}`);
  else compare(f, r.json?.orders);
}
const key = `idem-${run}`;
const body = { client_order_ref: `TP${run}-IDEM`, sku: 'HX-2201', quantity: 1, ship_to: { name: 'Dana Ortiz', street: '418 Harbor Street', city: 'Hartford', state: 'CT', zip: '06103' } };
const first = await call('POST', '/v1/orders', { token, body, headers: { 'idempotency-key': key } });
const second = await call('POST', '/v1/orders', { token, body, headers: { 'idempotency-key': key } });
check('api: retry with same Idempotency-Key returns the first response', second.headers.get('idempotent-replay') === 'true' && second.json?.message_id === first.json?.message_id);

// Fix a held API order through PATCH
const list = await call('GET', '/v1/orders', { token });
const held = list.json?.find((o) => o.client_order_ref === `TP${run}-A04`);
const fixed = held && await call('PATCH', `/v1/orders/${held.ref}`, { token, body: { ship_to: { street: '418 Harbor Street' } } });
check('api: PATCH releases the held order once fixed', fixed?.json?.status === 'accepted' || fixed?.json?.status === 'corrected', fixed?.json?.status);
const other = await call('POST', '/auth/login', { body: { client_id: 'C190', client_secret: creds.C190 } });
check('api: another client cannot read this order', held && (await call('GET', `/v1/orders/${held.ref}`, { token: other.json?.access_token })).status === 404);

// Email, EDI and file drop
for (const f of Object.keys(expected).filter((k) => k.startsWith('email/'))) compare(f, (await call('POST', '/ingest/email', { body: { filename: f, content: read(f) } })).json?.orders);
for (const f of Object.keys(expected).filter((k) => k.startsWith('edi/'))) compare(f, (await call('POST', '/ingest/edi', { body: { filename: f, content: read(f) } })).json?.orders);
for (const f of Object.keys(expected).filter((k) => k.startsWith('files/'))) compare(f, (await call('POST', '/ingest/file', { body: { filename: path.basename(f), content: read(f) } })).json?.orders);

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(width)}  ${r.detail}`);
console.log(`\n${rows.length - failures}/${rows.length} checks passed (run ${run})`);
process.exit(failures ? 1 : 0);
