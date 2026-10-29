import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StockAgent } from '../src/agents/stock.js';
import { DEFAULT_SETTINGS as S } from '../src/agents/settings.js';

const orders = (client, region, n, misses) =>
  Array.from({ length: n }, (_, i) => ({ client_id: client, destination_region: region, stock_miss: i < misses ? 1 : 0 }));

test('a client and region that often miss stock get stock moved before the next day', () => {
  const agent = new StockAgent(S);
  agent.observe([...orders('C1', 'West', 10, 3), ...orders('C2', 'West', 10, 0)]);
  const { pairs, decisions } = agent.planTransfers();
  assert.ok(pairs.has('C1|West'));
  assert.ok(!pairs.has('C2|West'));
  assert.equal(decisions[0].agent, 'stock');
  assert.equal(decisions[0].missRate, 0.3);
});

test('nothing is planned from orders it has not seen yet, nor from too few orders', () => {
  const agent = new StockAgent(S);
  assert.equal(agent.planTransfers().pairs.size, 0);
  agent.observe(orders('C1', 'West', 9, 9));
  assert.equal(agent.planTransfers().pairs.size, 0);
});

test('stock placed on earlier nights stays placed, and the limit applies only to new transfers', () => {
  const agent = new StockAgent({ ...S, transferLimitPerNight: 1 });
  agent.observe([...orders('C1', 'West', 10, 3), ...orders('C2', 'West', 10, 6)]);
  const night1 = agent.planTransfers();
  agent.commit(night1.pairs);
  assert.deepEqual([...night1.pairs], ['C2|West']);
  const night2 = agent.planTransfers();
  agent.commit(night2.pairs);
  assert.deepEqual([...night2.pairs].sort(), ['C1|West', 'C2|West']);
  assert.equal(night2.decisions.length, 1); // only C1 is a new transfer
  assert.deepEqual([...agent.planTransfers().pairs].sort(), ['C1|West', 'C2|West']);
});

test('above the nightly limit the highest miss rates go first and the rest need approval', () => {
  const agent = new StockAgent({ ...S, transferLimitPerNight: 1 });
  agent.observe([...orders('C1', 'West', 10, 3), ...orders('C2', 'West', 10, 6)]);
  const { pairs, decisions } = agent.planTransfers();
  assert.deepEqual([...pairs], ['C2|West']);
  assert.equal(decisions.find((d) => d.pair === 'C1|West').needsApproval, true);
  assert.equal(decisions.find((d) => d.pair === 'C2|West').needsApproval, false);
});
