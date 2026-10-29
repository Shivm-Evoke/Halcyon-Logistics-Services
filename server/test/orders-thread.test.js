import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThread, publicView } from '../src/orders/thread.js';
import { DEFAULT_SETTINGS } from '../src/agents/settings.js';

// Rates as the agents see them (per-carrier averages from the history).
const rates = { A: 16.69, B: 16.07, C: 17.8, D: 13.53, E: 14.23, F: 12.52 };

function setup({ claude = null } = {}) {
  const events = [];
  const approvals = [];
  const notices = [];
  const orders = new Map();
  const store = {
    async append(orderId, actor, type, detail = {}) { const e = { orderId, actor, type, detail }; events.push(e); return e; },
    async requestApproval(o, step, detail) { const row = { id: approvals.length + 1, run_id: 'thread', approval: 'pending', decision: { order_id: o.id, step, ...detail } }; approvals.push(row); return row; },
    async notify(o, message, actor) { notices.push({ orderId: o.id, message, actor }); },
    async setCarrier(id, carrierId) { orders.get(id).carrier_id = carrierId; },
    async getOrder(id) { return orders.get(id); },
  };
  const world = { model: { pOnTime: (o) => (['A', 'B', 'C'].includes(o.carrier_id) ? 0.95 : 0.7) }, limits: { A: 99, B: 99, C: 99, D: 99, E: 99, F: 99 }, rates };
  const thread = createThread({ store, world, settings: DEFAULT_SETTINGS, claude });
  const order = (over = {}) => {
    const o = {
      id: 1, ref: 'IN-000001', client_id: 'C190', account_tier: 'Tier 1', account_status: 'threatening_to_leave', sla: 1,
      warehouse_id: 'W3', distance_miles: 140, commitment_type: 'same_day', received_ts: '2026-10-27 10:15', carrier_id: 'D',
      promised_date: '2026-10-28', tracking_token: 'abc123', ...over,
    };
    orders.set(o.id, o);
    return o;
  };
  return { thread, events, approvals, notices, order };
}

test('a released same-day order at 10:15 goes on the second wave and to A, B or C, with an event per step', async () => {
  const { thread, events, order } = setup();
  const o = order();
  await thread.release(o);
  assert.deepEqual(events.map((e) => e.type), ['wave_assigned', 'carrier_selected', 'tracking_sent']);
  assert.equal(events[0].detail.wave, 2);
  assert.equal(events[0].actor, 'wave_planner');
  assert.ok(['A', 'B', 'C'].includes(events[1].detail.carrier_id), events[1].detail.rule);
  assert.equal(o.carrier_id, events[1].detail.carrier_id);
  assert.match(events[2].detail.url, /\/track\/abc123$/);
});

test('a delay for a Tier 1 or at-risk client asks a supervisor before the client is told', async () => {
  const { thread, events, approvals, notices, order } = setup();
  await thread.carrierEvent(order(), 'delayed');
  assert.deepEqual(events.map((e) => e.type), ['delayed', 'risk_flagged', 'approval_requested']);
  assert.equal(approvals.length, 1);
  assert.equal(notices.length, 0);
  assert.match(approvals[0].decision.message, /IN-000001/);
});

test('approving the notice tells the client; rejecting it does not', async () => {
  const { thread, events, approvals, notices, order } = setup();
  await thread.carrierEvent(order(), 'delayed');
  await thread.resume({ ...approvals[0], approval: 'approved', actor: 'supervisor' });
  assert.deepEqual(events.slice(-2).map((e) => e.type), ['approved', 'client_notified']);
  assert.equal(notices.length, 1);

  const second = setup();
  await second.thread.carrierEvent(second.order(), 'delayed');
  await second.thread.resume({ ...second.approvals[0], approval: 'rejected', actor: 'supervisor' });
  assert.equal(second.events.at(-1).type, 'rejected');
  assert.equal(second.notices.length, 0);
});

test('a delay for an ordinary client is notified without approval', async () => {
  const { thread, events, approvals, order } = setup();
  await thread.carrierEvent(order({ account_tier: 'Tier 3', account_status: 'active' }), 'delayed');
  assert.ok(events.some((e) => e.type === 'client_notified'));
  assert.equal(approvals.length, 0);
});

test('the notice comes from Claude when it answers, otherwise from the template, and says which', async () => {
  const withAi = setup({ claude: { writeNotice: async () => ({ text: 'Sorry, IN-000001 is running a day late.', source: 'claude' }) } });
  await withAi.thread.carrierEvent(withAi.order(), 'delayed');
  assert.equal(withAi.approvals[0].decision.source, 'claude');
  const offline = setup();
  await offline.thread.carrierEvent(offline.order(), 'delayed');
  assert.equal(offline.approvals[0].decision.source, 'rules only');
});

test('the public tracking view shows status and plain labels but no internal detail', () => {
  const view = publicView({ ref: 'IN-000001', status: 'corrected', commitment_type: 'same_day', promised_date: '2026-10-28', carrier_id: 'B' }, [
    { ts: '2026-10-27 10:16', actor: 'intake_agent', type: 'received', detail: { issues: ['x'] } },
    { ts: '2026-10-27 10:20', actor: 'carrier_agent', type: 'carrier_selected', detail: { carrier_id: 'B', rule: 'internal rule text' } },
    { ts: '2026-10-27 15:00', actor: 'carrier', type: 'delayed', detail: { days: 1 } },
    { ts: '2026-10-27 15:01', actor: 'supervisor', type: 'approval_requested', detail: { message: 'draft' } },
  ]);
  assert.equal(view.stage, 'on_the_way');
  assert.equal(view.promised_date, '2026-10-28');
  assert.equal(view.eta, '2026-10-29');
  assert.match(view.banner, /late/i);
  assert.ok(view.events.every((e) => !('detail' in e) && !('actor' in e)));
  assert.ok(!view.events.some((e) => e.type === 'approval_requested'));
});
