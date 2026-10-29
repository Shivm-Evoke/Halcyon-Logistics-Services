// Sends the synthetic live week through the running gateway and scores it against the ground truth
// recorded by generate-live-week.mjs. Writes ingest/live-week/report.json (shown on the Inbound gateway screen).
//   node ingest/run-live-week.mjs            (API_URL defaults to http://localhost:4000/api)
//   SITE_PASSWORD=... when the deployment is password-protected
import fs from 'node:fs';
import path from 'node:path';
import { scoreWeek } from './score-week.mjs';

const API = process.env.API_URL || 'http://localhost:4000/api';
const SITE = process.env.SITE_PASSWORD && { authorization: `Basic ${Buffer.from(`halcyon:${process.env.SITE_PASSWORD}`).toString('base64')}` };
const DIR = path.join(import.meta.dirname, 'live-week');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const creds = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'test-data/credentials.json'), 'utf8'));
const run = Date.now().toString(36).slice(-4).toUpperCase();

// Unique PO numbers per run, so the week can be replayed without everything being a duplicate.
// Base64 email bodies are decoded, re-tagged and re-encoded.
const tag = (s) => s.replaceAll('LW-', `LW${run}-`);
const retag = (content) => tag(content).replace(/(Content-Transfer-Encoding: base64\r?\n\r?\n)([A-Za-z0-9+/=\r\n]+)/, (_, head, body) =>
  head + Buffer.from(tag(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'))).toString('base64').replace(/.{76}/g, '$&\r\n'));

async function call(method, url, { body, token, headers = {} } = {}) {
  const res = await fetch(`${API}${url}`, {
    method, headers: { 'content-type': 'application/json', ...SITE, ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}
const tokens = {};
async function tokenFor(clientId) {
  if (!tokens[clientId]) {
    const r = await call('POST', '/auth/login', { body: { client_id: clientId, client_secret: creds[clientId] } });
    if (r.status !== 200) throw new Error(`Login failed for ${clientId}: ${r.status}`);
    tokens[clientId] = r.json.access_token;
  }
  return tokens[clientId];
}

const started = Date.now();
const scored = [];
let replayChecks = 0; let replayOk = 0; let httpErrors = 0;
for (const [i, m] of manifest.files.entries()) {
  const raw = retag(fs.readFileSync(path.join(DIR, m.dir, m.file), 'utf8'));
  let r;
  if (m.dir === 'email') r = await call('POST', '/ingest/email', { body: { filename: m.file, content: raw } });
  else if (m.dir === 'edi') r = await call('POST', '/ingest/edi', { body: { filename: m.file, content: raw } });
  else if (m.dir === 'files') r = await call('POST', '/ingest/file', { body: { filename: m.file, content: raw } });
  else {
    const payload = JSON.parse(raw);
    const token = await tokenFor(payload.client_id);
    const key = m.retry_with_same_key ? `lw-${run}-${i}` : undefined;
    r = await call('POST', '/v1/orders', { token, body: { orders: payload.orders }, headers: key ? { 'idempotency-key': key } : {} });
    if (key) {   // the client's network dropped the response, so it retries with the same key
      const again = await call('POST', '/v1/orders', { token, body: { orders: payload.orders }, headers: { 'idempotency-key': key } });
      replayChecks++;
      if (again.headers.get('idempotent-replay') === 'true' && again.json?.message_id === r.json?.message_id) replayOk++;
    }
  }
  if (r.status !== 200 || !r.json?.orders) { httpErrors++; continue; }
  m.orders.forEach((exp, k) => {
    const got = r.json.orders[k];
    scored.push({ ...exp, file: `${m.dir}/${m.file}`, actual: got?.status ?? 'missing', codes: got?.issues.map((x) => x.code) ?? [], fixes: got?.corrections.map((c) => c.field) ?? [], risk: got?.late_risk ?? null });
  });
  if ((i + 1) % 100 === 0) process.stdout.write(`  ${i + 1}/${manifest.files.length} messages\n`);
}
const seconds = (Date.now() - started) / 1000;

const report = scoreWeek({ manifest, scored, run, seconds, httpErrors, replayChecks, replayOk });
const { defects } = report;
fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 2));

const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`\nLive week ${manifest.generated_for}: ${report.messages} messages, ${report.orders} orders in ${seconds.toFixed(1)} s (run ${run})`);
console.log(`Outcome matched ground truth: ${pct(report.status_accuracy)} · defects caught ${report.defect_detection.caught}/${report.defect_detection.injected} · clean orders wrongly stopped ${report.clean_orders.wrongly_stopped}/${report.clean_orders.total} · idempotent retries ${replayOk}/${replayChecks}`);
for (const d of defects) console.log(`  ${d.rate === 1 ? '✓' : '✗'} ${d.label.padEnd(48)} ${String(d.caught).padStart(4)}/${String(d.injected).padEnd(4)} ${pct(d.rate)}${d.misses.length ? `   e.g. ${d.misses[0].po} -> ${d.misses[0].actual} [${d.misses[0].codes.join(', ')}]` : ''}`);
process.exit(httpErrors ? 1 : 0);
