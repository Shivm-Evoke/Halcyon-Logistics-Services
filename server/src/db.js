import pg from 'pg';

pg.types.setTypeParser(1700, Number);            // numeric -> number
pg.types.setTypeParser(20, Number);              // bigint (count) -> number
pg.types.setTypeParser(1082, (v) => v);          // date stays 'YYYY-MM-DD'
pg.types.setTypeParser(1114, (v) => v.slice(0, 16)); // timestamp stays local 'YYYY-MM-DD HH:MM'

// A hosted database is given as DATABASE_URL (add ?sslmode=require for an external connection); locally, PGDATABASE.
export const pool = new pg.Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : { database: process.env.PGDATABASE || 'halcyon' });

export const q = async (text, params) => (await pool.query(text, params)).rows;
export const one = async (text, params) => (await q(text, params))[0];

// The dataset ends on 25 Sep 2026; the control tower treats this moment as "now".
export const DEMO_NOW = process.env.DEMO_NOW || '2026-09-22 12:00';
