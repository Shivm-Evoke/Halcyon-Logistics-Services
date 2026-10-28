// Creates API credentials for every client (each enterprise client can integrate by API). Secrets are random, written to
// ingest/test-data/credentials.json (git-ignored, test use only) and stored in the database as scrypt hashes.
// A deployment passes its secrets as a read-only file in API_CREDENTIALS_FILE, which is used as given.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { hashSecret } from '../src/ingest/auth.js';

const GIVEN = process.env.API_CREDENTIALS_FILE;
const FILE = GIVEN || path.resolve(import.meta.dirname, '../../ingest/test-data/credentials.json');

const clients = (await pool.query('SELECT client_id FROM clients ORDER BY client_id')).rows.map((r) => r.client_id);
const creds = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
if (!GIVEN) {
  for (const id of clients) creds[id] ??= `test_${crypto.randomBytes(18).toString('base64url')}`;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(creds, null, 2));
}
for (const [id, secret] of Object.entries(creds)) {
  await pool.query(`INSERT INTO api_clients (client_id, secret_hash) VALUES ($1, $2)
                    ON CONFLICT (client_id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash`, [id, hashSecret(secret)]);
}
console.log(`API credentials ready for ${Object.keys(creds).length} clients (see ingest/test-data/credentials.json)`);
await pool.end();
