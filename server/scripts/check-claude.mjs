// Checks the connection to Claude on Microsoft Foundry with one small request; never prints the key.
//   npm --prefix server run check:claude      (reads server/.env)
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { createClaude, MODEL } from '../src/agents/claude.js';

const { ANTHROPIC_FOUNDRY_API_KEY: key, ANTHROPIC_FOUNDRY_RESOURCE: resource, ANTHROPIC_FOUNDRY_BASE_URL: baseURL } = process.env;
console.log(`Resource: ${resource || baseURL || '(not set)'}  Model: ${MODEL}  Key: ${key ? `set (${key.length} characters)` : '(not set)'}`);
const claude = createClaude();
if (!claude.available) {
  console.log('Claude is not configured: set ANTHROPIC_FOUNDRY_API_KEY and ANTHROPIC_FOUNDRY_RESOURCE in server/.env');
  process.exit(1);
}
const started = Date.now();
const r = await claude.explain(
  { agent: 'carrier', carrier_id: 'B', rule: 'Lowest expected cost among A, B and C (same-day or Tier 1)', extraCost: 1.35 },
  { order: { client_name: 'Client 055', tier: 'Tier 1' }, simTime: '10:30' },
);
console.log(`${r.source === 'claude' ? 'Connected' : 'NOT connected (fell back to the rule)'} in ${Date.now() - started} ms: ${r.text}`);
if (r.source !== 'claude') {
  // Ask once more without the fallback, to show why: a wrong deployment name is a 404, a bad key a 401.
  try {
    await new AnthropicFoundry().messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] });
    console.log('A direct request worked; the agents\' request was refused or timed out.');
  } catch (e) {
    console.log(`Reason: ${e.status ? `HTTP ${e.status} ` : ''}${e.message}`);
  }
}
process.exit(r.source === 'claude' ? 0 : 1);
