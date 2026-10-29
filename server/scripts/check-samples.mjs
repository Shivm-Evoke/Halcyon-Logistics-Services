// Sends the five sample orders through the portal's code path for the demo customer's client on the ops clock
// 2026-09-25 09:15 (a Friday; this starts a new desk run), runs the agents and checks each sample gets its decision.
//   npm --prefix server run check:samples      (writes the orders and decisions to the local database)
import { pool } from '../src/db.js';
import { getContainer } from '../src/container.js';
import { getDesk, deskClockNow } from '../src/desk/instance.js';
import { deskRepo } from '../src/desk/repository.js';
import { SAMPLES, sendSample, forceFor } from '../src/portal/channels.js';

const CLIENT = process.env.DEMO_CUSTOMER_CLIENT || 'C055';
const CLOCK = '2026-09-25 09:15';

// What each sample is for, and the agent decision that shows it.
const EXPECT = {
  1: { cause: 'incomplete address', agent: 'intake', ok: () => true },
  2: { cause: 'same-day after the 08:00 cutoff', agent: 'wave', ok: (d) => d.wave === 2 },
  3: { cause: 'stock missing at the nearest warehouse', agent: 'stock', ok: () => true },
  4: { cause: 'same-day / Tier 1 carrier over the cost cap', agent: 'carrier', ok: (d) => d.needsApproval },
  5: { cause: 'high late risk', agent: 'watchtower', ok: () => true },
};

const desk = await getDesk();
if (!desk.enabled) {
  console.log('The desk is off (DESK=0): nothing to check');
  process.exit(1);
}
const { ingest } = await getContainer();
await desk.setClock(CLOCK);
const force = forceFor({ client_id: CLIENT }, deskClockNow());
console.log(`Client ${CLIENT}, ops clock ${force.received_ts}`);

const sent = [];
for (const n of Object.keys(SAMPLES)) {
  const { channel, result } = await sendSample(ingest, n, force);
  sent.push({ n, channel, order: result.orders[0] });
}
await desk.refresh();
await desk.idle();
const state = await desk.state();
const rows = await deskRepo.decisions(state.clock.runId);

let failed = 0;
for (const { n, channel, order } of sent) {
  const e = EXPECT[n];
  const ds = rows.filter((r) => r.delivery_id === order.ref);
  const pass = ds.some((r) => r.agent === e.agent && e.ok(r.decision));
  if (!pass) failed++;
  const risk = order.late_risk == null ? '-' : order.late_risk.toFixed(2);
  console.log(`\n${pass ? 'PASS' : 'FAIL'} ${n} ${channel} (${e.cause}): ${order.ref ?? '(not stored)'} ${order.status}, gateway carrier ${order.carrier_id ?? '-'}, risk ${risk}`);
  for (const i of order.issues ?? []) console.log(`     issue ${i.code}: ${i.message}`);
  if (!ds.length) console.log('     no agent decisions');
  for (const r of ds) {
    const d = r.decision;
    const detail = [d.wave != null && `wave ${d.wave}`, d.carrier_id && `carrier ${d.carrier_id}`, d.action && `action ${d.action}`,
      d.risk != null && `risk ${Number(d.risk).toFixed(2)}`].filter(Boolean).join(', ');
    console.log(`     ${r.agent} [${r.approval}] ${detail ? `(${detail}) ` : ''}${r.reason_source === 'claude' ? r.reason : r.rule}`);
  }
  if (!pass) console.log(`     expected: a ${e.agent} decision${n === '2' ? ' for wave 2' : n === '4' ? ' needing approval' : ''}`);
}
console.log(`\n${sent.length - failed} of ${sent.length} samples got their expected decision`);
await pool.end();
process.exit(failed ? 1 : 0);
