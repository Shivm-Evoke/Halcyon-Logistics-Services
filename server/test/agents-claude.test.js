import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '../src/agents/claude.js';
import { fillUnparseable } from '../src/ingest/channels/email.js';

const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const fake = (respond) => {
  const calls = [];
  return { calls, beta: { messages: { create: async (params) => { calls.push(params); return respond(params, calls.length); } } } };
};
const decision = { agent: 'carrier', delivery_id: 'D1', carrier_id: 'A', rule: 'Lowest expected cost among A, B and C' };

test('explain returns Claude\'s sentence, on the configured model at low effort', async () => {
  const client = fake(() => text('Moved to A because D is late on a third of short-haul orders.'));
  const r = await createClaude({ client }).explain(decision, {});
  assert.deepEqual(r, { text: 'Moved to A because D is late on a third of short-haul orders.', source: 'claude' });
  assert.equal(client.calls[0].model, 'claude-opus-5-5');
  assert.equal(client.calls[0].output_config.effort, 'low');
});

test('a slow, failing or refusing Claude falls back to the rule', async () => {
  const slow = createClaude({ client: fake(() => new Promise(() => {})), timeoutMs: 30 });
  assert.deepEqual(await slow.explain(decision, {}), { text: decision.rule, source: 'rules only' });
  const broken = createClaude({ client: fake(() => { throw new Error('503'); }) });
  assert.equal((await broken.explain(decision, {})).source, 'rules only');
  const refusing = createClaude({ client: fake(() => ({ stop_reason: 'refusal', content: [] })) });
  assert.equal((await refusing.explain(decision, {})).source, 'rules only');
});

test('without a client or Foundry settings Claude is unavailable and every call is rules only', async () => {
  const saved = { key: process.env.ANTHROPIC_FOUNDRY_API_KEY, res: process.env.ANTHROPIC_FOUNDRY_RESOURCE, url: process.env.ANTHROPIC_FOUNDRY_BASE_URL };
  delete process.env.ANTHROPIC_FOUNDRY_API_KEY; delete process.env.ANTHROPIC_FOUNDRY_RESOURCE; delete process.env.ANTHROPIC_FOUNDRY_BASE_URL;
  try {
    const c = createClaude();
    assert.equal(c.available, false);
    assert.equal((await c.explain(decision, {})).source, 'rules only');
    assert.equal((await c.extractEmail('anything')).order, null);
  } finally {
    for (const [k, v] of [['ANTHROPIC_FOUNDRY_API_KEY', saved.key], ['ANTHROPIC_FOUNDRY_RESOURCE', saved.res], ['ANTHROPIC_FOUNDRY_BASE_URL', saved.url]]) if (v !== undefined) process.env[k] = v;
  }
});

const order = { client_hint: 'C055', client_order_ref: 'PO-9', sku: 'HX-2201', quantity: '40', service: 'next day', ship_to: { name: 'Ann Lee', street: '12 Elm St', city: 'Hartford', state: 'CT', zip: '06103' } };

test('extractEmail asks for structured output and returns a valid order', async () => {
  const client = fake(() => text(JSON.stringify({ order, confidence: 0.92 })));
  const r = await createClaude({ client }).extractEmail('hi, pls send 40 of hx2201 to Ann Lee 12 elm st hartford ct 06103 tmrw. PO-9');
  assert.equal(r.source, 'claude');
  assert.equal(r.confidence, 0.92);
  assert.equal(r.order.sku, 'HX-2201');
  assert.equal(client.calls[0].output_config.format.type, 'json_schema');
});

test('extractEmail output that fails the schema is discarded', async () => {
  const r = await createClaude({ client: fake(() => text('{"order": {"sku": 5}}')) }).extractEmail('x');
  assert.deepEqual(r, { order: null, confidence: 0, source: 'rules only' });
  const junk = await createClaude({ client: fake(() => text('not json')) }).extractEmail('x');
  assert.equal(junk.order, null);
});

test('briefing runs strict tools in a loop and stops at the iteration cap', async () => {
  let n = 0;
  const client = fake((params, call) => {
    assert.equal(params.tool_choice.type, 'auto');
    assert.ok(params.tools.every((t) => t.strict === true));
    if (call === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_state', input: {} }] };
    return text('Wave 2 placed 41 same-day orders; 2 carrier upgrades await approval.');
  });
  const tools = { get_state: async () => { n++; return { simTime: '11:30' }; }, run_agent: async () => [], list_pending_approvals: async () => [], explain_decision: async () => '' };
  const r = await createClaude({ client }).briefing({ simTime: '11:30' }, tools);
  assert.equal(n, 1);
  assert.equal(r.source, 'claude');
  assert.match(r.text, /Wave 2/);
  assert.deepEqual(r.toolCalls, ['get_state']);
  const looping = fake(() => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'get_state', input: {} }] }));
  const capped = await createClaude({ client: looping }).briefing({}, tools);
  assert.equal(looping.calls.length, 6);
  assert.equal(capped.source, 'rules only');
});

test('an email the parser cannot read becomes an order when Claude is confident', async () => {
  const records = [{ client_sender: 'C055', received_ts: '2026-09-25 09:00', client_hint: 'C055', source_ref: 'body', unparseable: true, ship_to: {} }];
  const confident = await fillUnparseable(records, 'text', async () => ({ order, confidence: 0.9, source: 'claude' }), 0.8);
  assert.equal(confident.length, 1);
  assert.equal(confident[0].unparseable, undefined);
  assert.equal(confident[0].sku, 'HX-2201');
  assert.equal(confident[0].received_ts, '2026-09-25 09:00');
  assert.equal(confident[0].source_ref, 'body (read by AI)');
  const unsure = await fillUnparseable(records, 'text', async () => ({ order, confidence: 0.5, source: 'claude' }), 0.8);
  assert.equal(unsure[0].unparseable, true);
  const parsed = [{ ...records[0], unparseable: undefined, sku: 'HX-1' }];
  let called = false;
  await fillUnparseable(parsed, 'text', async () => { called = true; return {}; }, 0.8);
  assert.equal(called, false);
});

test('briefings come back as plain text even if Claude adds markdown bold', async () => {
  const client = fake(() => text('**14:00 briefing**\n\nAll **11** flags need approval.'));
  const r = await createClaude({ client }).briefing({ simTime: '14:00' }, { get_state: async () => ({}) });
  assert.equal(r.text, '14:00 briefing\n\nAll 11 flags need approval.');
});

test('the committed example settings file never carries a real key', async () => {
  const fs = await import('node:fs');
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^ANTHROPIC_FOUNDRY_API_KEY=$/m, 'put the key in server/.env, not server/.env.example');
});

test('a failing Claude call is logged once per distinct reason, with its HTTP status', async () => {
  const warned = [];
  const original = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const client = fake(() => { throw Object.assign(new Error('Access denied due to invalid subscription key'), { status: 401 }); });
    const c = createClaude({ client });
    await c.explain(decision, {});
    await c.explain(decision, {});
    assert.equal(warned.length, 1);
    assert.match(warned[0], /Claude call failed: HTTP 401 Access denied/);
  } finally {
    console.warn = original;
  }
});
