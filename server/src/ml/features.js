// The late-risk model's feature set, and how to build it from a delivery row or a new order.
// Every feature is known by despatch time, so the model can score an order before it ships.

export const RISK_FEATURES = [
  { name: 'order_channel', type: 'categorical', values: ['API', 'EDI', 'Email'] },
  { name: 'commitment_type', type: 'categorical', values: ['same_day', 'next_day', 'standard'] },
  { name: 'cutoff_breach', type: 'binary' },          // same-day received after the pick-list cutoff
  { name: 'after_cutoff', type: 'binary' },
  { name: 'address_incomplete', type: 'binary' },
  { name: 'stock_miss', type: 'binary' },             // nearest warehouse had no stock (or its probability)
  { name: 'carrier_id', type: 'categorical', values: ['A', 'B', 'C', 'D', 'E', 'F'] },
  { name: 'distance_miles', type: 'numeric', transform: 'log1p' },
  { name: 'destination_region', type: 'categorical', values: ['Midwest', 'Southeast', 'Northeast', 'West'] },
  { name: 'fulfilment_warehouse_id', type: 'categorical', values: ['W1', 'W2', 'W3', 'W4', 'W5'] },
  { name: 'account_tier', type: 'categorical', values: ['Tier 1', 'Tier 2', 'Tier 3'] },
  { name: 'sla', type: 'binary' },
  { name: 'stops_on_route', type: 'numeric' },
  { name: 'received_dow', type: 'categorical', values: [0, 1, 2, 3, 4, 5, 6] },
  // Interactions: late risk saturates once one thing has gone wrong, and a no-API carrier
  // matters most on an otherwise clean order. Without these the model is badly over-confident.
  { name: 'multi_failure', type: 'binary' },
  { name: 'noapi_clean', type: 'binary' },
];

// Adds the derived interaction features. Run on every row before training or scoring.
export const makePrepare = (noApiCarriers) => (row) => {
  const failures = (row.address_incomplete || 0) + (row.stock_miss || 0) + (row.cutoff_breach || 0);
  return {
    ...row,
    // Fractional inputs (e.g. a stock-miss probability) give a fractional value between the two cases.
    multi_failure: failures >= 2 ? 1 : Math.max(0, failures - 1),
    noapi_clean: noApiCarriers.has(row.carrier_id) ? Math.max(0, 1 - failures) : 0,
  };
};

export const FEATURE_LABELS = {
  order_channel: 'Order channel',
  commitment_type: 'Service promised',
  cutoff_breach: 'Same-day after 8am cutoff',
  after_cutoff: 'Received after 8am',
  address_incomplete: 'Incomplete address',
  stock_miss: 'Stock not at nearest warehouse',
  carrier_id: 'Carrier',
  distance_miles: 'Shipping distance',
  destination_region: 'Destination region',
  fulfilment_warehouse_id: 'Shipping warehouse',
  account_tier: 'Account tier',
  sla: 'SLA client',
  stops_on_route: 'Stops on route',
  received_dow: 'Day of week',
  multi_failure: 'Several problems at once',
  noapi_clean: 'No-API carrier on a clean order',
};

// Builds model input for an order that has not shipped yet (intake).
export function orderFeatures({ order_channel, commitment_type, received_ts, address_incomplete, stock_miss,
  carrier_id, warehouse_id, destination_region, distance_miles, client }) {
  const [date, time = '00:00'] = String(received_ts).replace(' ', 'T').split('T');
  const hour = Number(time.slice(0, 2));
  const [y, m, d] = date.split('-').map(Number);
  return {
    order_channel,
    commitment_type,
    received_hour: hour,
    received_dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
    cutoff_breach: commitment_type === 'same_day' && hour >= 8 ? 1 : 0,
    after_cutoff: hour >= 8 ? 1 : 0,
    address_incomplete,
    stock_miss,
    carrier_id,
    distance_miles,
    destination_region,
    fulfilment_warehouse_id: warehouse_id,
    account_tier: client?.account_tier,
    sla: client?.sla_penalty_clause === 'Y' ? 1 : 0,
    stops_on_route: null,      // unknown before route planning: the encoder uses the average
  };
}
