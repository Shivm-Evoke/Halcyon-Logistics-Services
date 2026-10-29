// Claude on Microsoft Azure AI Foundry: the agents' reading, judgement and explanations in the live day.
// Every call has a rule-based answer to fall back on, so a slow, failing or refusing model never stops the operation:
// the decision stands and its reason reads "rules only".
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk/lib/middleware';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const FALLBACK_MODEL = process.env.CLAUDE_FALLBACK_MODEL || 'claude-opus-4-8';
const TIMEOUT_MS = 20000;
const MAX_TOOL_ROUNDS = 6;

const EXPLAIN_SYSTEM = `You explain decisions taken by Halcyon Logistics' operations agents to a warehouse manager.
You receive one decision as JSON (agent, rule applied, and the order's details). Reply with one or two plain sentences
saying what was done and why, using the numbers given. No preamble, no markdown.`;

const EXTRACT_SYSTEM = `You read customer order emails sent to Halcyon Logistics and extract the order.
Copy values as the customer wrote them; do not invent anything. Use an empty string for a value the email does not give.
Set confidence between 0 and 1: how sure you are that every non-empty value is what the customer meant.`;

const BRIEFING_SYSTEM = `You are the Ops Lead for Halcyon Logistics' operations agents (Intake, Wave Planner, Stock, Carrier,
Watchtower). Every half hour you brief the warehouse manager. Use the tools to look at the current state and the pending
approvals, and to re-run an agent if its result looks inconsistent with another's. Then write a short briefing: what the
agents did since the last briefing, any conflict between them, and what the manager needs to approve. At most five
sentences, plain text.`;

const str = { type: 'string' };
const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['order', 'confidence'],
  properties: {
    confidence: { type: 'number' },
    order: {
      type: 'object',
      additionalProperties: false,
      required: ['client_hint', 'client_order_ref', 'sku', 'quantity', 'service', 'ship_to'],
      properties: {
        client_hint: str, client_order_ref: str, sku: str, quantity: str, service: str,
        ship_to: { type: 'object', additionalProperties: false, required: ['name', 'street', 'city', 'state', 'zip'], properties: { name: str, street: str, city: str, state: str, zip: str } },
      },
    },
  },
};

/** Minimal check of a value against the subset of JSON Schema used here. */
function conforms(value, schema) {
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return schema.required.every((k) => k in value) && Object.entries(schema.properties).every(([k, s]) => !(k in value) || conforms(value[k], s));
  }
  return false;
}

const TOOLS = [
  { name: 'get_state', description: 'Current simulated time, counters, and the latest decisions of each agent.', input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  { name: 'run_agent', description: 'Re-run one agent\'s rules on the current state and return its decisions.', input_schema: { type: 'object', additionalProperties: false, properties: { agent: { type: 'string', enum: ['intake', 'wave', 'stock', 'carrier', 'watchtower'] } }, required: ['agent'] } },
  { name: 'list_pending_approvals', description: 'Decisions waiting for the manager\'s approval.', input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  { name: 'explain_decision', description: 'The full record of one logged decision.', input_schema: { type: 'object', additionalProperties: false, properties: { decision_id: { type: 'integer' } }, required: ['decision_id'] } },
].map((t) => ({ ...t, strict: true }));

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

function foundryClient() {
  const { ANTHROPIC_FOUNDRY_API_KEY, ANTHROPIC_FOUNDRY_RESOURCE, ANTHROPIC_FOUNDRY_BASE_URL } = process.env;
  if (!ANTHROPIC_FOUNDRY_API_KEY || !(ANTHROPIC_FOUNDRY_RESOURCE || ANTHROPIC_FOUNDRY_BASE_URL)) return null;
  // Server-side fallbacks are not available on Foundry, so a refusal is retried on the fallback model by the SDK.
  return new AnthropicFoundry({ middleware: [betaRefusalFallbackMiddleware([{ model: FALLBACK_MODEL }])] });
}

/**
 * @param client  an object with beta.messages.create (tests pass a fake); defaults to Foundry from environment variables
 */
export function createClaude({ client = foundryClient(), timeoutMs = TIMEOUT_MS } = {}) {
  const available = Boolean(client);

  async function call(params) {
    if (!client) throw new Error('Claude is not configured');
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude timed out')), timeoutMs); });
    try {
      const res = await Promise.race([client.beta.messages.create({ model: MODEL, ...params }, { timeout: timeoutMs }), timeout]);
      if (res.stop_reason === 'refusal') throw new Error('Claude declined');
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    available,

    async explain(decision, context = {}) {
      try {
        const res = await call({
          max_tokens: 1024, output_config: { effort: 'low' }, system: EXPLAIN_SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify({ decision, context }) }],
        });
        const text = textOf(res);
        return text ? { text, source: 'claude' } : { text: decision.rule, source: 'rules only' };
      } catch {
        return { text: decision.rule, source: 'rules only' };
      }
    },

    async extractEmail(rawText) {
      try {
        const res = await call({
          max_tokens: 2048, system: EXTRACT_SYSTEM,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: ORDER_SCHEMA } },
          messages: [{ role: 'user', content: rawText }],
        });
        const parsed = JSON.parse(textOf(res));
        if (!conforms(parsed, ORDER_SCHEMA)) throw new Error('schema');
        return { order: parsed.order, confidence: Math.max(0, Math.min(1, parsed.confidence)), source: 'claude' };
      } catch {
        return { order: null, confidence: 0, source: 'rules only' };
      }
    },

    /** @param tools { get_state, run_agent, list_pending_approvals, explain_decision }: async handlers */
    async briefing(state, tools) {
      const messages = [{ role: 'user', content: `Write the briefing for ${state.simTime ?? 'now'}. Current state: ${JSON.stringify(state)}` }];
      const toolCalls = [];
      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const res = await call({ max_tokens: 4096, output_config: { effort: 'medium' }, system: BRIEFING_SYSTEM, tools: TOOLS, tool_choice: { type: 'auto' }, messages });
          if (res.stop_reason !== 'tool_use') {
            const text = textOf(res);
            return text ? { text, toolCalls, source: 'claude' } : { text: '', toolCalls, source: 'rules only' };
          }
          messages.push({ role: 'assistant', content: res.content });
          const results = await Promise.all(res.content.filter((b) => b.type === 'tool_use').map(async (b) => {
            toolCalls.push(b.name);
            try {
              const out = await tools[b.name](b.input);
              return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out ?? null) };
            } catch (e) {
              return { type: 'tool_result', tool_use_id: b.id, content: String(e.message), is_error: true };
            }
          }));
          messages.push({ role: 'user', content: results });
        }
      } catch { /* fall through to rules only */ }
      return { text: '', toolCalls, source: 'rules only' };
    },
  };
}
