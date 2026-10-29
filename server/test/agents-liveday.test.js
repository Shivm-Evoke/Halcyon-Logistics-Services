import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDay, pickDemoDay } from '../src/agents/liveDay.js';
import { buildWorld, simulateDay, randForDay, isFriday } from '../src/agents/simulator.js';
import { createMemoryLog } from '../src/agents/log.js';
import { DEFAULT_SETTINGS } from '../src/agents/settings.js';

// Every incomplete address is completable, so Tier 1 fixes reliably wait for approval.
const S = { ...DEFAULT_SETTINGS, addressFixRate: 1 };

const distances = { W1: { West: 100 } };
const rates = { A: 15, D: 12 };
const DAY = '2026-09-25'; // a Friday
function history() {
  const rows = [];
  let id = 0;
  for (const day of ['2026-09-18', '2026-09-24', DAY]) {
    for (let i = 0; i < 60; i++) {
      const hour = (i * 23) % 24;
      const sameDay = i % 3 === 0;
      rows.push({
        delivery_id: `${day}-${++id}`, client_id: `C${i % 4}`, client_name: `Client ${i % 4}`, destination_region: 'West',
        received_ts: `${day} ${String(hour).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
        commitment_type: sameDay ? 'same_day' : 'standard', cutoff_breach: sameDay && hour >= 8 ? 1 : 0,
        address_incomplete: i % 5 === 0 ? 1 : 0, stock_miss: 0, nearest_warehouse_id: 'W1', fulfilment_warehouse_id: 'W1',
        distance_miles: 100, carrier_id: i % 2 ? 'D' : 'A', carrier_rate_usd: 12, account_tier: i % 10 === 0 ? 'Tier 1' : 'Tier 2',
        sla: i % 2, account_status: 'active', late: i % 4 === 0 ? 1 : 0,
      });
    }
  }
  return rows;
}
const echo = { available: true, explain: async (d) => ({ text: `AI: ${d.rule}`, source: 'claude' }), extractEmail: async () => ({ order: null }), briefing: async (s) => ({ text: `Briefing at ${s.simTime}`, toolCalls: [], source: 'claude' }) };
const make = (extra = {}) => new LiveDay({ day: DAY, orders: history(), distances, rates, settings: S, claude: echo, log: createMemoryLog(), ...extra });

test('the demo day is the September Friday with the lowest recorded on-time rate', () => {
  const rows = [
    ...['2026-09-04', '2026-09-11'].flatMap((d, k) => Array.from({ length: 10 }, (_, i) => ({ received_ts: `${d} 09:00`, late: i < (k ? 6 : 2) ? 1 : 0 }))),
    ...Array.from({ length: 10 }, () => ({ received_ts: '2026-09-10 09:00', late: 1 })), // a Thursday
  ];
  assert.equal(pickDemoDay(rows), '2026-09-11');
});

test('the second wave appears only once the clock reaches it', async () => {
  const live = make();
  await live.advance(8 * 60);
  assert.equal((await live.state()).lanes.wave.filter((e) => e.decision.wave === 2).length, 0);
  await live.advance(5 * 60);
  const s = await live.state();
  assert.equal(s.simTime, '13:00');
  assert.ok(s.lanes.wave.some((e) => e.decision.wave === 2));
});

test('at midnight the counters equal the engine\'s result for the whole day', async () => {
  const live = make();
  await live.advance(24 * 60);
  await live.idle();
  const s = await live.state();
  const orders = history();
  const { model, capacity } = buildWorld(orders, S);
  const dayOrders = orders.filter((o) => o.received_ts.startsWith(DAY)).sort((a, b) => a.received_ts.localeCompare(b.received_ts) || a.delivery_id.localeCompare(b.delivery_id));
  const { decided } = simulateDay(dayOrders, { settings: S, model, distances, rates, limits: capacity.forDay(dayOrders.length).limits, stockPairs: live.stockPairs, isFriday: isFriday(DAY), rand: randForDay(S.seed, DAY), approvals: new Map(), autoApprove: false });
  const expected = decided.reduce((t, o) => t + o.pOnTime, 0) / decided.length;
  assert.ok(Math.abs(s.counters.agents - expected) < 1e-9, `${s.counters.agents} vs ${expected}`);
  assert.equal(s.counters.orders, 60);
});

test('the run keeps its id and Claude reasons arrive on notable decisions', async () => {
  const live = make();
  await live.advance(14 * 60);
  await live.idle();
  const a = await live.state();
  const b = await live.state();
  assert.equal(a.runId, b.runId);
  const all = Object.values(a.lanes).flat();
  assert.ok(all.some((e) => e.reason_source === 'claude' && e.reason.startsWith('AI: ')));
  assert.ok(a.briefings.some((x) => x.text === 'Briefing at 08:00'));
});

test('an approval left pending for more than 120 simulated minutes expires', async () => {
  const live = make();
  await live.advance(60); // the Tier 1 order at 00:00 is waiting
  const pending = (await live.state()).approvals;
  assert.ok(pending.length > 0, 'fixture should produce a pending approval');
  const first = pending[0];
  await live.advance(2 * 60 + 30);
  const s = await live.state();
  assert.ok(!s.approvals.some((e) => e.id === first.id));
  const ev = Object.values(s.lanes).flat().find((e) => e.id === first.id);
  assert.equal(ev.approval, 'expired');
});

test('approving a decision changes what the agents do', async () => {
  const log = createMemoryLog();
  const live = make({ log });
  await live.advance(6 * 60);
  const pending = (await live.state()).approvals.find((e) => e.agent === 'intake');
  assert.ok(pending);
  await log.setApproval(pending.id, 'approved', 'manager');
  const s = await live.state();
  const ev = Object.values(s.lanes).flat().find((e) => e.id === pending.id);
  assert.equal(ev.approval, 'approved');
});

test('recorded mode replays saved reasons without calling Claude', async () => {
  const live = make();
  await live.advance(14 * 60);
  await live.idle();
  const recorded = live.recording();
  const throwing = { available: true, explain: async () => { throw new Error('offline'); }, briefing: async () => { throw new Error('offline'); } };
  const replay = make({ claude: throwing, mode: 'recorded', recorded });
  await replay.advance(14 * 60);
  await replay.idle();
  const s = await replay.state();
  assert.equal(s.mode, 'recorded');
  assert.ok(Object.values(s.lanes).flat().some((e) => e.reason.startsWith('AI: ')));
  assert.ok(s.briefings.some((x) => x.text === 'Briefing at 08:00'));
});
