// Checks the shipment events' time rule against a real database: an event is stamped with the time given (the ops
// clock) or now(), never before the order's latest event, and the stage is the latest event by time, then id.
// Runs only against the local test database, on rows it creates and deletes:
//   PGDATABASE=halcyon_test node server/scripts/check-event-order.mjs      (exits 1 on a failure)
import assert from 'node:assert/strict';

if (process.env.DATABASE_URL || process.env.PGDATABASE !== 'halcyon_test') {
  console.error('Refusing to run: set PGDATABASE=halcyon_test and no DATABASE_URL (local test database only).');
  process.exit(2);
}

const { pool, one, q } = await import('../src/db.js');
const { shipmentStore: store, ensureShipmentTable } = await import('../src/shipments/store.js');
const { deskRepo } = await import('../src/desk/repository.js');
const { stageOf } = await import('../src/shipments/stages.js');

const SOURCE = `check-event-order-${process.pid}`;
const newOrder = async () => {
  const m = await one("INSERT INTO inbound_messages (channel, source) VALUES ('API', $1) RETURNING id", [SOURCE]);
  return (await one("INSERT INTO inbound_orders (message_id, status, normalized) VALUES ($1, 'accepted', '{}') RETURNING id", [m.id])).id;
};
const events = (id) => store.eventsFor([id]);

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n${e.message}`); }
}

try {
  await ensureShipmentTable();
  const dbNow = (await one("SELECT to_char(now()::timestamp, 'YYYY-MM-DD HH24:MI') AS t")).t;

  await check('without a time an event is stamped now()', async () => {
    const id = await newOrder();
    const e = await store.addEvent(id, 'received');
    assert.ok(e.at >= dbNow, `${e.at} >= ${dbNow}`);
  });

  await check('a real-time event followed by ops-clock events: later events are raised to it, the stage order holds', async () => {
    const id = await newOrder();
    const first = await store.addEvent(id, 'received');                       // real time, e.g. 2026-10-29
    const picked = await store.advance(id, 'received', 'picked', 'ops clock', '2026-09-25 13:00');
    assert.ok(picked, 'advance applied');
    assert.equal(picked.at, first.at, 'raised to the latest event, not before it');
    const note = await deskRepo.addNoteOnce(id, 'picked', 'Carrier B chosen', '2026-09-25 13:00');
    assert.equal(note.at, first.at);
    assert.equal(await store.latestStage(id), 'picked');
    assert.equal(stageOf(await events(id)), 'picked');
    assert.equal(await store.advance(id, 'received', 'picked', 'ops clock', '2026-09-25 13:00'), undefined, 'a stale move is not applied');
  });

  await check('ops-clock events keep their times; a same-minute tie falls back to id', async () => {
    const id = await newOrder();
    const r = await store.recordVerdict({ id, status: 'accepted' }, '2026-09-25 09:15');
    assert.equal(r.at, '2026-09-25 09:15');
    const p = await store.advance(id, 'received', 'picked', 'staff', '2026-09-25 09:15');   // same minute
    assert.equal(p.at, '2026-09-25 09:15');
    assert.equal(await store.latestStage(id), 'picked');
    assert.equal(stageOf(await events(id)), 'picked');
    const c = await store.advance(id, 'picked', 'collected', 'ops clock', '2026-09-25 14:00');
    assert.equal(c.at, '2026-09-25 14:00', 'a later ops-clock time stands as given');
    assert.deepEqual((await events(id)).map((e) => [e.stage, e.at]),
      [['received', '2026-09-25 09:15'], ['picked', '2026-09-25 09:15'], ['collected', '2026-09-25 14:00']]);
  });
} finally {
  await q('DELETE FROM inbound_messages WHERE source = $1', [SOURCE]);   // cascades to the orders and their events
  await pool.end();
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
