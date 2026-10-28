// Runs every data-quality check and keeps the result until the data changes.
import { CHECKS } from './checks.js';

export class DataQualityScanner {
  /** @param query (sql) => rows   @param checks list of { id, severity, title, why, source, sql } */
  constructor(query, checks = CHECKS) {
    this.query = query;
    this.checks = checks;
    this.cache = null;
  }

  async scan({ samples = 8 } = {}) {
    if (this.cache) return this.cache;
    const started = performance.now();
    const results = await Promise.all(this.checks.map(async (c) => {
      const [{ n }] = await this.query(`SELECT count(*) AS n FROM (${c.sql}) t`);
      const rows = n ? await this.query(`SELECT * FROM (${c.sql}) t ORDER BY ref LIMIT ${samples}`) : [];
      const { sql, ...meta } = c;
      return { ...meta, count: n, samples: rows };
    }));
    this.cache = { scanned_at: new Date().toISOString(), ms: Math.round(performance.now() - started), checks: results };
    return this.cache;
  }

  async rows(id, limit = 500) {
    const c = this.checks.find((x) => x.id === id);
    return c ? this.query(`SELECT * FROM (${c.sql}) t ORDER BY ref LIMIT ${Number(limit)}`) : null;
  }

  invalidate() { this.cache = null; }
}
