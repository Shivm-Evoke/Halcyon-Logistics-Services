// The synthetic live week, sent through the gateway in-process (no HTTP, no client secrets) and scored against its
// ground truth. Used on deploy (SEED_DEMO_WEEK=1) and by the admin button, so a fresh database shows real numbers.
// The report is kept in the database because the container's file system does not survive a restart.
import fs from 'node:fs';
import path from 'node:path';
import { q, one } from '../db.js';
import { scoreWeek } from '../../../ingest/score-week.mjs';

export const LIVE_WEEK_DIR = path.resolve(import.meta.dirname, '../../../ingest/live-week');
const REPORT_KEY = 'live_week_report';

export const ensureAppStateTable = () => q(`
  CREATE TABLE IF NOT EXISTS app_state (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

export const savedReport = async () => (await one('SELECT value FROM app_state WHERE key = $1', [REPORT_KEY]))?.value ?? null;

/** Sends every message of the week through `ingest` (an IngestService) and stores the scored report. */
export async function runLiveWeek(ingest, { dir = LIVE_WEEK_DIR } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const run = Date.now().toString(36).slice(-4).toUpperCase();
  const started = Date.now();
  const scored = [];
  let errors = 0;
  for (const m of manifest.files) {
    const raw = fs.readFileSync(path.join(dir, m.dir, m.file), 'utf8');
    let r;
    try {
      if (m.dir === 'email') r = await ingest.email(raw, { filename: m.file });
      else if (m.dir === 'edi') r = await ingest.edi(raw, { filename: m.file });
      else if (m.dir === 'files') r = await ingest.csvFile(raw, { filename: m.file });
      else { const payload = JSON.parse(raw); r = await ingest.api(payload.client_id, payload.orders); }
    } catch (e) {
      errors++;
      console.error(`live week: ${m.dir}/${m.file} failed`, e.message);
      continue;
    }
    m.orders.forEach((exp, k) => {
      const got = r.orders[k];
      scored.push({ ...exp, file: `${m.dir}/${m.file}`, actual: got?.status ?? 'missing', codes: got?.issues.map((x) => x.code) ?? [],
        fixes: got?.corrections.map((c) => c.field) ?? [], risk: got?.late_risk ?? null });
    });
  }
  const report = { ...scoreWeek({ manifest, scored, run, seconds: (Date.now() - started) / 1000, httpErrors: errors }), mode: 'in-process' };
  await ensureAppStateTable();
  await q(`INSERT INTO app_state (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [REPORT_KEY, JSON.stringify(report)]);
  return report;
}
