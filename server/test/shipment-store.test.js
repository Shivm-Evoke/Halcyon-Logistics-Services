// The shipment store and the desk's note writer take an optional time (the ops clock); without one the database's
// now() stands. Run against a recording fake of the database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShipmentStore } from '../src/shipments/store.js';
import { createDeskRepo } from '../src/desk/repository.js';

function fakeDb(latest = 'received') {
  const calls = [];
  const run = async (sql, params) => { calls.push({ sql, params }); return /SELECT stage FROM/.test(sql) && !/INSERT/.test(sql) ? [{ stage: latest }] : [{ id: 1 }]; };
  return { calls, q: run, one: async (sql, params) => (await run(sql, params))[0] };
}

test('store: advance, addEvent and recordVerdict pass the ops clock time when given, else null (now())', async () => {
  const db = fakeDb(null);
  const store = createShipmentStore(db);
  await store.advance(7, 'received', 'picked', 'staff', '2026-09-25 13:00');
  await store.advance(7, 'received', 'picked', 'staff');
  await store.addEvent(7, 'received', 'system', null, '2026-09-25 09:15');
  await store.addEvent(7, 'received');
  for (const c of db.calls) assert.match(c.sql, /COALESCE\(\$\d+::timestamp, now\(\)::timestamp\)/);
  assert.deepEqual(db.calls.map((c) => c.params.at(-1)), ['2026-09-25 13:00', null, '2026-09-25 09:15', null]);
});

test('store: recordVerdict stamps the verdict at the given time', async () => {
  const db = fakeDb(null);
  const store = createShipmentStore(db);
  await store.recordVerdict({ id: 3, status: 'accepted' }, '2026-09-25 09:52');
  const insert = db.calls.find((c) => /INSERT/.test(c.sql));
  assert.deepEqual(insert.params, [3, 'received', 'system', null, '2026-09-25 09:52']);
  await store.recordVerdict({ id: 4, status: 'held' });
  assert.equal(db.calls.filter((c) => /INSERT/.test(c.sql)).at(-1).params.at(-1), null);
});

test('store: an event is never stamped before the order\'s latest event, so the stage order holds', async () => {
  const db = fakeDb();
  await createShipmentStore(db).addEvent(7, 'picked', 'staff', null, '2026-09-25 13:00');
  assert.match(db.calls[0].sql, /GREATEST\(COALESCE\(\$5::timestamp, now\(\)::timestamp\), \(SELECT max\(at\) FROM shipment_events WHERE order_id = \$1\)\)/);
});

test('desk repo: addNoteOnce stamps the note with the given time, else now()', async () => {
  const db = fakeDb();
  const repo = createDeskRepo(db);
  await repo.addNoteOnce(7, 'received', 'Carrier B chosen', '2026-09-25 09:52');
  await repo.addNoteOnce(7, 'received', 'Carrier B chosen');
  for (const c of db.calls) assert.match(c.sql, /COALESCE\(\$4::timestamp, now\(\)::timestamp\)/);
  assert.deepEqual(db.calls.map((c) => c.params), [[7, 'received', 'Carrier B chosen', '2026-09-25 09:52'], [7, 'received', 'Carrier B chosen', null]]);
});
