// Scores one run of the synthetic live week against the ground truth in its manifest.
// Shared by ingest/run-live-week.mjs (over HTTP) and the server's in-process seeder (server/src/ingest/liveWeek.js).

/**
 * @param manifest  ingest/live-week/manifest.json
 * @param scored    one entry per expected order: { ...manifest order, file, actual, codes, fixes, risk }
 */
export function scoreWeek({ manifest, scored, run, seconds, httpErrors = 0, replayChecks = 0, replayOk = 0 }) {
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
  return report;
}
