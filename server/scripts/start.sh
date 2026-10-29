#!/usr/bin/env bash
# Container start: load the dataset into an empty database, refresh the API client secrets, then run the API.
set -euo pipefail
cd "$(dirname "$0")/../.."
if ! psql "$DATABASE_URL" -Atc 'SELECT 1 FROM deliveries LIMIT 1' > /dev/null 2>&1; then
  echo 'Empty database: loading the dataset'
  bash db/load.sh
elif [ -n "${API_CREDENTIALS_FILE:-}" ]; then
  node server/scripts/seed-api-clients.mjs
fi
# SEED_DEMO_WEEK=1: send the synthetic week through the gateway once, so the Inbound gateway screen has data.
if [ "${SEED_DEMO_WEEK:-0}" = 1 ]; then
  node server/scripts/seed-demo-week.mjs || echo 'Demo week seeding failed; the app starts without it'
fi
exec node server/src/index.js
