#!/usr/bin/env bash
# Rebuild the halcyon database and load the hackathon dataset.
# Usage: db/load.sh [path-to-dataset]   (default: db/data)
# Targets DATABASE_URL when set (a hosted database), otherwise the local database PGDATABASE (default halcyon).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${1:-$HERE/data}"
if [ -n "${DATABASE_URL:-}" ]; then
  DB="$DATABASE_URL"
else
  DB="${PGDATABASE:-halcyon}"
  createdb "$DB" 2>/dev/null || true
  export PGDATABASE="$DB"
fi
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/schema.sql"

load() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -c "\\copy $1 FROM '$DATA/$2' WITH (FORMAT csv, HEADER true, NULL '')"; }
load clients clients.csv
load carriers carriers.csv
load warehouses warehouses.csv
load warehouse_region_distance warehouse_region_distance_miles.csv
load deliveries deliveries.csv
load sla_penalties sla_penalties.csv
load complaints complaints.csv
load cs_time_study customer_success_time_study.csv

psql -d "$DB" -Atc "SELECT 'deliveries: ' || count(*) FROM deliveries UNION ALL SELECT 'on-time: ' || round(avg((on_time='Y')::int)*100,1) || '%' FROM deliveries"

# Test API credentials for the inbound gateway (secrets in ingest/test-data/credentials.json).
node "$HERE/../server/scripts/seed-api-clients.mjs"
