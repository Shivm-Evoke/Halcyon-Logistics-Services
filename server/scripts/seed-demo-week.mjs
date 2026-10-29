// Deploy-time seeding: sends the synthetic live week through the gateway once, when no message has been ingested yet.
//   node server/scripts/seed-demo-week.mjs          (start.sh runs it when SEED_DEMO_WEEK=1)
import { getContainer } from '../src/container.js';
import { one, pool } from '../src/db.js';
import { runLiveWeek, ensureAppStateTable } from '../src/ingest/liveWeek.js';

await ensureAppStateTable();
const { n } = await one('SELECT count(*)::int AS n FROM inbound_messages');
if (n > 0) {
  console.log(`Demo week: ${n} messages already ingested, nothing to do`);
} else {
  const container = await getContainer();
  const r = await runLiveWeek(container.ingest);
  console.log(`Demo week seeded: ${r.messages} messages, ${r.orders} orders, outcome match ${(r.status_accuracy * 100).toFixed(1)}%`);
}
await pool.end();
