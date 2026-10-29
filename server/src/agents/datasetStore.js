// Storage for uploaded test datasets, kept apart from the real history so a test never changes the real numbers.
import { q, one } from '../db.js';

export const ensureDatasetTable = () => q(`
  CREATE TABLE IF NOT EXISTS agent_datasets (
    id           serial PRIMARY KEY,
    name         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    rows         integer NOT NULL,
    days         jsonb NOT NULL,
    has_outcomes boolean NOT NULL,
    rejected     jsonb NOT NULL DEFAULT '[]',
    orders       jsonb NOT NULL
  )`);

export const datasetStore = {
  save: ({ name, orders, days, hasOutcomes, rejected }) => one(
    `INSERT INTO agent_datasets (name, rows, days, has_outcomes, rejected, orders) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, created_at, rows, days, has_outcomes`,
    [name, orders.length, JSON.stringify(days), hasOutcomes, JSON.stringify(rejected), JSON.stringify(orders)],
  ),
  list: () => q(`SELECT id, name, created_at, rows, days, has_outcomes, jsonb_array_length(rejected) AS rejected
                 FROM agent_datasets ORDER BY id DESC`),
  orders: async (id) => (await one('SELECT orders FROM agent_datasets WHERE id = $1', [id]))?.orders ?? null,
};
