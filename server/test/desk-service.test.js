// The desk service on an in-memory repo, decision log and shipment store: idempotent re-runs, approvals,
// expiry, runs started by setting the clock, restarts, failures and stage moves on the ops clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesk } from '../src/desk/service.js';
import { createMemoryLog } from '../src/agents/log.js';
import { DEFAULT_SETTINGS } from '../src/agents/settings.js';
import { initialStage, stageOf } from '../src/shipments/stages.js';

const S = { ...DEFAULT_SETTINGS, addressFixRate: 1 };
const MIN = 60000;
const distances = { W1: { West: 100 } };
// A is always on time and costs 20 more than B or C: same-day orders want A, over the $6 cap.
const rates = { A: 30, B: 10, C: 10, D: 5 };
const ship_to = { name: 'A', street: '1 Main St', city: 'Los Angeles', state: 'CA', zip: '90001' };

function history() {
  const rows = [];
  let id = 0;
  for (const day of ['2026-09-17', '2026-09-18', '2026-09-24']) {
    for (const carrier of ['A', 'B', 'C', 'D']) {
      for (let i = 0; i < 40; i++) {
        rows.push({
          delivery_id: `H${++id}`, client_id: `C${i % 4}`, destination_region: 'West', received_ts: `${day} 07:${String(i % 60).padStart(2, '0')}`,
          commitment_type: i % 2 ? 'same_day' : 'standard', cutoff_breach: 0, address_incomplete: 0, stock_miss: 0,
          nearest_warehouse_id: 'W1', fulfilment_warehouse_id: 'W1', distance_miles: 100, carrier_id: carrier, late: carrier === 'A' ? 0 : 1,
        });
      }
    }
  }
  return rows;
}
const WORLD = { orders: history(), distances, rates };

const UPDATABLE = ['commitment_type', 'promised_date', 'carrier_id', 'warehouse_id', 'status'];
const clone = (x) => structuredClone(x);

/** The deskRepo, decision table and shipment store in memory, on a real-time clock the test moves. */
function fakeDb() {
  const log = createMemoryLog();
  const state = { t: new Date('2026-10-29T10:00:00Z'), clock: null, orders: [], events: [], nextId: 1 };
  // As shipmentStore: `at` is the time given (the ops clock) or real time, never before the order's latest event.
  const realTs = () => new Date(state.t).toISOString().slice(0, 16).replace('T', ' ');
  const event = (order_id, stage, by, note = null, at = null) => {
    const last = state.events.filter((x) => x.order_id === order_id).map((x) => x.at).sort().at(-1);
    const t = at ?? realTs();
    const e = { id: state.events.length + 1, order_id, stage, by, note, at: last && last > t ? last : t };
    state.events.push(e);
    return e;
  };
  const latest = (id) => stageOf(state.events.filter((e) => e.order_id === id));
  const noUndefined = (o) => { for (const [k, v] of Object.entries(o)) if (v === undefined) throw new Error(`undefined ${k}`); };
  const repo = {
    getClock: async () => (state.clock ? { ...state.clock } : null),
    setClock: async (setTo) => {
      state.clock = { set_to: setTo, set_at: new Date(state.t), run_no: (state.clock?.run_no ?? 0) + 1, run_started_at: new Date(state.t), run_from: setTo };
      return { ...state.clock };
    },
    shiftClock: async (to) => (state.clock ? { ...Object.assign(state.clock, { set_to: to, set_at: new Date(state.t) }) } : null),
    liveOrders: async (since) => state.orders.filter((o) => ['accepted', 'corrected', 'held'].includes(o.status) && o.created_at >= new Date(since)).map(clone),
    updateOrder: async (id, fields) => {
      noUndefined(fields);
      const o = state.orders.find((x) => x.id === id);
      for (const k of UPDATABLE) if (k in fields) o[k] = fields[k];
      return clone(o);
    },
    addNoteOnce: async (orderId, stage, note, at = null) => (state.events.some((e) => e.order_id === orderId && e.note === note) ? null : event(orderId, stage, 'agents', note, at)),
    // As deskRepo: the run's rows by id; updateDecision writes the row itself, so approvals and expiry see it.
    decisions: async (runId) => (await log.list({ runId, limit: 1e9 })).reverse().map(clone),
    updateDecision: async (id, { decision, rule, reset = null }) => {
      noUndefined({ decision, rule });
      return log.update(id, { decision: clone(decision), rule, ...(reset ? { ...reset, actor: null, reason: rule, reason_source: 'rules only' } : {}) });
    },
  };
  const shipments = {
    eventsFor: async (ids) => state.events.filter((e) => ids.includes(e.order_id)).map(clone),
    advance: async (orderId, from, next, by, at = null) => (latest(orderId) === from ? event(orderId, next, by, null, at) : null),
    recordVerdict: async (order, at = null) => {
      const stage = initialStage(order.status);
      const current = latest(order.id);
      if (current === stage || (current && current !== 'on_hold' && current !== 'received')) return null;
      return event(order.id, stage, 'system', null, at);
    },
  };
  /** Adds an order as the gateway would, received now on the ops clock. */
  const addOrder = (receivedTs, over = {}) => {
    const id = state.nextId++;
    const o = {
      id, client_id: 'C1', client_name: 'Acme', account_tier: 'Tier 2', account_status: 'active', status: 'accepted', channel: 'API',
      normalized: { sku: 'X', quantity: 1, ship_to, commitment_type: 'same_day', received_ts: receivedTs },
      corrections: [], issues: [{ code: 'same_day_after_cutoff', severity: 'info', message: 'after cutoff' }], risk: '0.3',
      commitment_type: 'same_day', promised_date: receivedTs.slice(0, 10), warehouse_id: 'W1', carrier_id: 'D',
      created_at: new Date(state.t), ...over,
    };
    state.orders.push(o);
    event(id, initialStage(o.status), 'system', null, receivedTs); // the gateway records its verdict at the ops clock
    return o;
  };
  const tick = (minutes) => { state.t = new Date(state.t.getTime() + minutes * MIN); };
  const notes = (orderId) => state.events.filter((e) => e.order_id === orderId && e.note).map((e) => e.note);
  return { log, repo, shipments, state, addOrder, tick, notes, latest };
}

const deskOn = (db, over = {}) => createDesk({
  repo: db.repo, log: db.log, shipments: db.shipments, world: async () => WORLD, settings: S, now: () => new Date(db.state.t),
  logger: { error: () => {} }, ...over,
});

test('two refreshes give the same decisions and no duplicate notes', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15');
  db.addOrder('2026-09-25 09:15', { status: 'held' });
  await desk.refresh();
  const first = await db.log.list({ limit: 1e9 });
  const notes = db.notes(o.id);
  assert.ok(first.length >= 3);
  await desk.refresh();
  assert.equal((await db.log.list({ limit: 1e9 })).length, first.length);
  assert.deepEqual(db.notes(o.id), notes);
  assert.equal(new Set(notes).size, notes.length);
});

test('approving the pending carrier decision gives the order that carrier, noted once', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15');
  await desk.refresh();
  const s = await desk.state();
  const pending = s.approvals.find((a) => a.agent === 'carrier');
  assert.ok(pending, 'a carrier decision waits for approval');
  const chosen = (await db.repo.decisions(s.clock.runId)).find((d) => d.id === pending.id).decision.carrier_id;
  assert.equal(chosen, 'A');
  assert.equal(db.state.orders[0].carrier_id, 'D');
  await db.log.setApproval(pending.id, 'approved', 'manager');
  await desk.refresh();
  await desk.refresh();
  assert.equal(db.state.orders[0].carrier_id, 'A');
  assert.equal(db.notes(o.id).filter((n) => n.startsWith('Carrier A chosen')).length, 1);
});

test('a decision pending for more than 120 simulated minutes expires and the safe carrier stands', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  db.addOrder('2026-09-25 09:15');
  await desk.refresh();
  const id = (await desk.state()).approvals.find((a) => a.agent === 'carrier').id;
  db.tick(120);
  await desk.refresh();
  assert.equal((await db.log.list({ limit: 1e9 })).find((r) => r.id === id).approval, 'pending');
  db.tick(1);
  await desk.refresh();
  assert.equal((await db.log.list({ limit: 1e9 })).find((r) => r.id === id).approval, 'expired');
  assert.ok(['B', 'C'].includes(db.state.orders[0].carrier_id));
});

test('setting the clock again starts a new run without the earlier orders', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  db.addOrder('2026-09-25 09:15');
  await desk.refresh();
  assert.equal((await desk.state()).orders.length, 1);
  db.tick(5);
  const s = await desk.setClock('2026-09-25 07:30');
  assert.equal(s.clock.runId, 'desk-2026-09-25-2');
  assert.deepEqual(s.orders, []);
  db.tick(1);
  const o = db.addOrder('2026-09-25 07:31');
  await desk.refresh();
  assert.deepEqual((await desk.state()).orders.map((x) => x.ref), [`IN-${String(o.id).padStart(6, '0')}`]);
});

test('a desk rebuilt from the same stores (restart) shows the same state', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  // The gateway keeps its carrier on the order, so a re-run after the desk changed it notes nothing new.
  const kept = { normalized: { sku: 'X', quantity: 1, ship_to, commitment_type: 'same_day', received_ts: '2026-09-25 09:15', gateway_carrier_id: 'D' } };
  db.addOrder('2026-09-25 09:15', kept);
  db.addOrder('2026-09-25 09:15', { status: 'held', ...kept });
  await desk.refresh();
  const before = await desk.state();
  const again = deskOn(db);
  assert.equal(again.clockNow(), null);
  assert.deepEqual(await again.state(), before);
  assert.equal(again.clockNow(), '2026-09-25 09:15');
  await again.refresh();
  assert.deepEqual(await again.state(), before);
});

test('state carries the gateway checks, the decisions and counts per agent', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  db.addOrder('2026-09-25 09:15', { corrections: [{ field: 'zip', from: '9000', to: '90001', rule: 'zip' }, { field: 'x', rule: 'formatting' }] });
  await desk.refresh();
  const s = await desk.state();
  const [o] = s.orders;
  assert.deepEqual(o.checks.map((c) => c.kind), ['issue', 'correction']);
  assert.equal(o.agentsRun, true);
  assert.equal(o.received_ts, '2026-09-25 09:15');
  assert.ok(o.decisions.some((d) => d.agent === 'wave'));
  assert.equal(s.counts.wave, 1);
  assert.equal(s.counts.carrier, 1);
});

test('a run that throws is logged and leaves the orders as the gateway made them', async () => {
  const db = fakeDb();
  const errors = [];
  const desk = deskOn(db, { world: async () => { throw new Error('no history'); }, logger: { error: (m) => errors.push(m) } });
  await desk.setClock('2026-09-25 09:15');
  db.addOrder('2026-09-25 09:15');
  await desk.refresh();
  assert.equal(errors.at(-1), 'Desk run failed: no history');
  const s = await desk.state();
  assert.equal(s.orders[0].agentsRun, false);
  assert.equal(s.orders[0].carrier_id, 'D');
});

test('the intake agent releases a held order it can complete', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15', { status: 'held' });
  await desk.refresh();
  assert.equal(db.state.orders[0].status, 'corrected');
  assert.equal(db.latest(o.id), 'received');
  assert.ok(db.notes(o.id).includes("Address completed from the client's records"));
});

test('advance moves the clock to the next event and orders through their stages', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 07:30');
  const early = db.addOrder('2026-09-25 07:30', { commitment_type: 'standard', promised_date: '2026-09-28', normalized: { ship_to, commitment_type: 'standard', received_ts: '2026-09-25 07:30' } });
  const late = db.addOrder('2026-09-25 07:30', { commitment_type: 'standard', promised_date: null, normalized: { ship_to, commitment_type: 'standard', received_ts: '2026-09-25 07:30' } });
  let s = await desk.advance();
  assert.equal(s.clock.now, '2026-09-25 08:00');
  assert.equal(db.latest(early.id), 'picked');
  s = await desk.advance();
  assert.equal(s.clock.now, '2026-09-25 13:00');
  assert.equal(db.latest(late.id), 'picked');
  while (s.clock.now < '2026-09-28 23:59') s = await desk.advance();
  assert.equal(s.clock.now, '2026-09-28 23:59');
  assert.equal(s.clock.runId, 'desk-2026-09-25-1', 'advancing keeps the run');
  assert.equal(db.latest(early.id), 'delivered');
  assert.equal(db.latest(late.id), 'in_transit', 'no promised date: never delivered');
});

test('advanceOrder moves one live order one stage; an unknown ref is null', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15');
  const r = await desk.advanceOrder(`IN-${String(o.id).padStart(6, '0')}`);
  assert.equal(r.moved, true);
  assert.equal(r.stage, 'picked');
  assert.equal(db.latest(o.id), 'picked');
  assert.equal(await desk.advanceOrder('IN-999999'), null);
});

test('Claude explains new notable decisions in the background', async () => {
  const db = fakeDb();
  const claude = { available: true, explain: async (d) => ({ source: 'claude', text: `Because ${d.agent}` }) };
  const desk = deskOn(db, { claude });
  await desk.setClock('2026-09-25 09:15');
  db.addOrder('2026-09-25 09:15');
  await desk.refresh();
  await desk.idle();
  const wave = (await desk.state()).orders[0].decisions.find((d) => d.agent === 'wave');
  assert.deepEqual([wave.reason, wave.reason_source], ['Because wave', 'claude']);
});

test('with the desk off nothing runs and the state says so', async () => {
  const db = fakeDb();
  const desk = deskOn(db, { enabled: false });
  db.addOrder('2026-09-25 09:15');
  await desk.refresh();
  assert.equal(desk.clockNow(), null);
  assert.deepEqual(await desk.state(), { enabled: false, clock: null, orders: [], approvals: [], counts: { intake: 0, wave: 0, stock: 0, carrier: 0, watchtower: 0 } });
  assert.equal(db.state.clock, null);
  assert.equal((await db.log.list()).length, 0);
});

// Order 1 alone wants carrier A over the cap; a same-day order arriving later loses more without A and takes the
// day's only A slot, so order 1 moves to D within the cap (and back when order 2 leaves the run).
const standard = (ts) => ({ commitment_type: 'standard', promised_date: '2026-09-28', normalized: { ship_to, commitment_type: 'standard', received_ts: ts } });
const carrierRow = async (db, ref) => (await db.log.list({ limit: 1e9 })).find((r) => r.agent === 'carrier' && r.delivery_id === ref);

test('an approval does not carry over when a later order changes the carrier decision', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15', standard('2026-09-25 09:15'));
  await desk.refresh();
  const ref = `IN-${String(o.id).padStart(6, '0')}`;
  const first = await carrierRow(db, ref);
  assert.deepEqual([first.decision.carrier_id, first.approval], ['A', 'pending']);
  await db.log.setApproval(first.id, 'approved', 'manager');
  await desk.refresh();
  assert.equal(db.state.orders[0].carrier_id, 'A');

  db.tick(10);
  db.addOrder('2026-09-25 09:25');
  await desk.refresh();
  const after = await carrierRow(db, ref);
  assert.equal(after.id, first.id, 'still one row per agent and order');
  assert.deepEqual([after.decision.carrier_id, after.decision.needsApproval, after.approval, after.actor, after.sim_ts], ['D', false, 'auto', null, '2026-09-25 09:25']);
  assert.equal(db.state.orders[0].carrier_id, 'D');
  const s = await desk.state();
  assert.equal(s.approvals.some((a) => a.ref === ref), false);
  const two = s.approvals.find((a) => a.agent === 'carrier');
  assert.equal(two.ref, `IN-${String(o.id + 1).padStart(6, '0')}`, 'the newcomer now waits for approval of A');
});

test('a decision taken without approval waits for staff once it needs approval', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15', standard('2026-09-25 09:15'));
  const other = db.addOrder('2026-09-25 09:15');
  await desk.refresh();
  const ref = `IN-${String(o.id).padStart(6, '0')}`;
  assert.deepEqual([(await carrierRow(db, ref)).decision.carrier_id, (await carrierRow(db, ref)).approval], ['D', 'auto']);

  db.tick(5);
  other.status = 'rejected';
  await desk.refresh();
  const row = await carrierRow(db, ref);
  assert.deepEqual([row.decision.carrier_id, row.approval, row.sim_ts], ['A', 'pending', '2026-09-25 09:20']);
  assert.equal(db.state.orders[0].carrier_id, 'D', 'not applied before approval');
  assert.ok((await desk.state()).approvals.some((a) => a.ref === ref && a.agent === 'carrier'));
});

// ---- one clock: the desk stamps shipment events with the ops clock; staff see the whole timeline ----

test('notes and stage moves by the desk are stamped with the ops clock, not real time', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 07:30');          // real time is 2026-10-29 10:00
  const o = db.addOrder('2026-09-25 07:30', standard('2026-09-25 07:30'));
  db.tick(37);                                       // ops clock 08:07: the first wave has picked it
  await desk.refresh();
  const notes = db.state.events.filter((e) => e.order_id === o.id && e.note);
  assert.ok(notes.length, 'the agents wrote notes');
  for (const e of notes) assert.equal(e.at, '2026-09-25 08:07', e.note);
  await desk.advance();                              // 13:00
  await desk.advance();                              // 14:00: collected
  const r = await desk.advanceOrder(`IN-${String(o.id).padStart(6, '0')}`);   // Move on
  assert.equal(r.stage, 'in_transit');
  const moves = db.state.events.filter((e) => e.order_id === o.id && !e.note).map((e) => [e.stage, e.at]);
  assert.deepEqual(moves, [
    ['received', '2026-09-25 07:30'], ['picked', '2026-09-25 08:07'], ['collected', '2026-09-25 14:00'], ['in_transit', '2026-09-25 14:00'],
  ]);
  assert.ok(db.state.events.every((e) => e.at.startsWith('2026-09-25')), 'no real-time stamps');
});

test('a held order the desk releases is received at the ops clock', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15', { status: 'held' });
  db.tick(10);
  await desk.refresh();
  const received = db.state.events.find((e) => e.order_id === o.id && e.stage === 'received' && !e.note);
  assert.equal(received.at, '2026-09-25 09:25');
});

test('state carries each order\'s shipment events for the timeline, oldest first', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  await desk.setClock('2026-09-25 09:15');
  const o = db.addOrder('2026-09-25 09:15', standard('2026-09-25 09:15'));
  await desk.refresh();
  await desk.advanceOrder(`IN-${String(o.id).padStart(6, '0')}`);
  const [order] = (await desk.state()).orders;
  assert.ok(Array.isArray(order.events));
  assert.deepEqual(order.events.filter((e) => !e.note).map((e) => [e.stage, e.at, e.by]),
    [['received', '2026-09-25 09:15', 'system'], ['picked', '2026-09-25 09:15', 'staff']]);
  assert.ok(order.events.some((e) => e.by === 'agents' && e.note));
  for (const e of order.events) assert.deepEqual(Object.keys(e).sort(), ['at', 'by', 'note', 'stage']);
  assert.equal(order.promised_date, '2026-09-28');
  assert.equal(typeof order.risk, 'number');
});

test('currentClock loads the ops clock on first use, before any run; with the desk off it is null', async () => {
  const db = fakeDb();
  const desk = deskOn(db);
  assert.equal(desk.clockNow(), null, 'not loaded yet');
  assert.equal(await desk.currentClock(), '2026-09-25 09:15');
  db.tick(5);
  assert.equal(await desk.currentClock(), '2026-09-25 09:20');
  assert.equal(await deskOn(fakeDb(), { enabled: false }).currentClock(), null);
});
