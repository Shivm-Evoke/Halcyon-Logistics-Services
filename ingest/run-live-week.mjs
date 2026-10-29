// Sends the synthetic live week through the running gateway and scores it against the ground truth
// recorded by generate-live-week.mjs. Writes ingest/live-week/report.json (shown on the Inbound gateway screen).
//   node ingest/run-live-week.mjs            (API_URL defaults to http://localhost:4000/api)
//   SITE_PASSWORD=... when the deployment is password-protected
//   STAFF_EMAIL=... STAFF_PASSWORD=... to sign in as staff when the internal gateway routes need it
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
    method, headers: { 'content-type': 'application/json', ...SITE, ...STAFF, ...(token && { authorization: `Bearer ${token}` }), ...headers },
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

// ---------- Score ----------
// How the gateway is expected to handle each problem, from the outcome it should produce.
const KIND = { corrected: 'auto-fix', held: 'hold', rejected: 'reject', duplicate: 'reject', accepted: 'flag' };
const caught = (o, d) => {
  const e = manifest.defect_catalogue[d].expect;
  return e.fix ? o.fixes.includes(e.fix) : o.codes.includes(e.issue);
};
const defects = Object.entries(manifest.defect_catalogue).map(([code, def]) => {
  const hits = scored.filter((o) => o.defects.includes(code));
  const missed = hits.filter((o) => !caught(o, code));
  return { code, label: def.label, outcome: def.outcome, kind: KIND[def.outcome],
    injected: hits.length, caught: hits.length - missed.length, rate: hits.length ? (hits.length - missed.length) / hits.length : null,
    misses: missed.slice(0, 5).map((o) => ({ po: o.po, file: o.file, actual: o.actual, codes: o.codes })) };
}).filter((d) => d.injected > 0).sort((a, b) => b.injected - a.injected);

const STATUSES = ['accepted', 'corrected', 'held', 'rejected', 'duplicate'];
const confusion = STATUSES.map((e) => ({ expected: e, ...Object.fromEntries(STATUSES.map((a) => [a, scored.filter((o) => o.expected === e && o.actual === a).length])) }));
const clean = scored.filter((o) => !o.defects.length);
const falseAlarms = clean.filter((o) => !['accepted', 'corrected'].includes(o.actual));
const byChannel = ['Email', 'API', 'EDI', 'File'].map((c) => {
  const xs = scored.filter((o) => o.channel === c);
  return { channel: c, orders: xs.length, ...Object.fromEntries(STATUSES.map((s) => [s, xs.filter((o) => o.actual === s).length])), with_defects: xs.filter((o) => o.defects.length).length };
});
const statusMatch = scored.filter((o) => o.actual === o.expected).length;
const report = {
  run, ran_at: new Date().toISOString(), week: manifest.generated_for, seconds, messages: manifest.files.length, orders: scored.length, http_errors: httpErrors,
  status_accuracy: statusMatch / scored.length,
  defect_detection: { injected: defects.reduce((s, d) => s + d.injected, 0), caught: defects.reduce((s, d) => s + d.caught, 0) },
  clean_orders: { total: clean.length, wrongly_stopped: falseAlarms.length, examples: falseAlarms.slice(0, 5).map((o) => ({ po: o.po, file: o.file, actual: o.actual, codes: o.codes })) },
  idempotent_retries: { tried: replayChecks, replayed: replayOk },
  by_channel: byChannel, confusion, defects,
  avg_risk: { clean: avg(clean.map((o) => o.risk)), with_defects: avg(scored.filter((o) => o.defects.length && o.risk != null).map((o) => o.risk)) },
};
function avg(xs) { const v = xs.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 2));

const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`\nLive week ${manifest.generated_for}: ${report.messages} messages, ${report.orders} orders in ${seconds.toFixed(1)} s (run ${run})`);
console.log(`Outcome matched ground truth: ${pct(report.status_accuracy)} · defects caught ${report.defect_detection.caught}/${report.defect_detection.injected} · clean orders wrongly stopped ${falseAlarms.length}/${clean.length} · idempotent retries ${replayOk}/${replayChecks}`);
for (const d of defects) console.log(`  ${d.rate === 1 ? '✓' : '✗'} ${d.label.padEnd(48)} ${String(d.caught).padStart(4)}/${String(d.injected).padEnd(4)} ${pct(d.rate)}${d.misses.length ? `   e.g. ${d.misses[0].po} -> ${d.misses[0].actual} [${d.misses[0].codes.join(', ')}]` : ''}`);
process.exit(httpErrors ? 1 : 0);
