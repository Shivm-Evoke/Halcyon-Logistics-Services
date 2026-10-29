// Test datasets: orders uploaded as CSV, in the columns of the hackathon's deliveries.csv, for the agents to run on.
// Every row is checked; bad rows are reported with their line and reason, good rows become orders in the same shape
// the agents get from the history. "on_time" is optional: without it the agents are judged against the history yardstick.
import { parseCsv } from '../ingest/channels/csv.js';
import { PICK_LIST_CUTOFF } from '../rules.js';

export const REQUIRED_COLUMNS = ['client_id', 'order_received_ts', 'commitment_type', 'address_status', 'destination_region',
  'nearest_warehouse_id', 'nearest_warehouse_had_stock', 'distance_miles', 'carrier_id'];
export const OPTIONAL_COLUMNS = ['delivery_id', 'order_id', 'order_channel', 'fulfilment_warehouse_id', 'carrier_rate_usd', 'on_time'];
export const MAX_ROWS = 100000;

const ALLOWED = {
  commitment_type: ['same_day', 'next_day', 'standard'],
  address_status: ['complete', 'incomplete'],
  destination_region: ['Midwest', 'Southeast', 'Northeast', 'West'],
  nearest_warehouse_id: ['W1', 'W2', 'W3', 'W4', 'W5'],
  fulfilment_warehouse_id: ['W1', 'W2', 'W3', 'W4', 'W5'],
  nearest_warehouse_had_stock: ['Y', 'N'],
  carrier_id: ['A', 'B', 'C', 'D', 'E', 'F'],
  order_channel: ['API', 'EDI', 'Email'],
  on_time: ['Y', 'N'],
};
const CUTOFF_HOUR = Number(PICK_LIST_CUTOFF.slice(0, 2));
const TS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/;

/**
 * @param text    CSV text
 * @param clients Map client_id -> { client_name, account_tier, sla_penalty_clause, account_status }
 * @returns {{ orders, rejected: {line, reason}[], hasOutcomes, days } | { error, missing?, orders: [], rejected: [] }}
 */
export function parseDataset(text, { clients }) {
  const rows = parseCsv(text || '');
  if (!rows.length) return { error: 'The file has no order rows', orders: [], rejected: [] };
  if (rows.length > MAX_ROWS) return { error: `At most ${MAX_ROWS.toLocaleString('en-US')} rows per file`, orders: [], rejected: [] };
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in rows[0]));
  if (missing.length) return { error: `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, missing, orders: [], rejected: [] };

  const orders = [];
  const rejected = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 2; // the header is line 1
    const fail = (reason) => rejected.push({ line, reason });
    for (const c of REQUIRED_COLUMNS) if (!r[c]) return fail(`${c} is empty`);
    for (const [c, values] of Object.entries(ALLOWED)) {
      if (r[c] && !values.includes(r[c])) return fail(`${c} "${r[c]}" must be one of ${values.join(', ')}`);
    }
    const ts = r.order_received_ts.match(TS);
    if (!ts || Number.isNaN(Date.parse(`${ts[1]}T${ts[2]}:${ts[3]}:00Z`))) return fail(`order_received_ts "${r.order_received_ts}" must look like 2026-11-02 09:15`);
    const distance = Number(r.distance_miles);
    if (!Number.isFinite(distance) || distance < 0) return fail(`distance_miles "${r.distance_miles}" must be a number of 0 or more`);
    const rate = r.carrier_rate_usd ? Number(r.carrier_rate_usd) : null;
    if (rate != null && !(rate >= 0)) return fail(`carrier_rate_usd "${r.carrier_rate_usd}" must be a number of 0 or more`);
    const client = clients.get(r.client_id);
    if (!client) return fail(`Client ${r.client_id} is not a Halcyon client`);
    const id = r.delivery_id || `R${line}`;
    if (seen.has(id)) return fail(`delivery_id ${id} is a duplicate`);
    seen.add(id);

    const hour = Number(ts[2]);
    const received = `${ts[1]} ${ts[2]}:${ts[3]}`;
    orders.push({
      delivery_id: id,
      order_id: r.order_id || id,
      client_id: r.client_id,
      client_name: client.client_name,
      order_channel: r.order_channel || 'API',
      commitment_type: r.commitment_type,
      received_ts: received,
      order_received_ts: received,
      received_hour: hour,
      after_cutoff: hour >= CUTOFF_HOUR ? 1 : 0,
      cutoff_breach: r.commitment_type === 'same_day' && hour >= CUTOFF_HOUR ? 1 : 0,
      address_incomplete: r.address_status === 'incomplete' ? 1 : 0,
      stock_miss: r.nearest_warehouse_had_stock === 'N' ? 1 : 0,
      destination_region: r.destination_region,
      nearest_warehouse_id: r.nearest_warehouse_id,
      fulfilment_warehouse_id: r.fulfilment_warehouse_id || r.nearest_warehouse_id,
      distance_miles: distance,
      carrier_id: r.carrier_id,
      carrier_rate_usd: rate,
      account_tier: client.account_tier,
      sla: client.sla_penalty_clause === 'Y' ? 1 : 0,
      account_status: client.account_status,
      late: r.on_time === 'N' ? 1 : r.on_time === 'Y' ? 0 : null,
    });
  });
  if (!orders.length) return { error: 'No row passed the checks', orders, rejected };
  return {
    orders,
    rejected,
    hasOutcomes: orders.every((o) => o.late != null),
    days: [...new Set(orders.map((o) => o.received_ts.slice(0, 10)))].sort(),
  };
}
