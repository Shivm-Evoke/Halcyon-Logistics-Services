// Validation of a normalised order. Each issue has a stable code so clients, reports and
// tests can rely on it. Severity: fatal -> reject, error -> hold for correction, warning -> accept.
import { isUsState, statesForZip, zipRangeText } from '../rules.js';

const SKU = /^[A-Z]{2,4}-\d{1,6}$/;
const MAX_REASONABLE_QTY = 5000;

export function validateOrder(o, { clients, otherClientsUsingRef = [] }) {
  const issues = [];
  const add = (code, severity, field, message, suggestion) => issues.push({ code, severity, field, message, ...(suggestion && { suggestion }) });
  const a = o.ship_to || {};

  if (o.unparseable) add('unparseable', 'fatal', null, 'No order details could be read from this message');
  for (const e of o.structural_errors || []) add('edi_structure', 'fatal', null, e);
  if (!o.client_id) add('missing_client', 'fatal', 'client_id', 'The client account could not be identified');
  else if (!clients.has(o.client_id)) add('unknown_client', 'fatal', 'client_id', `Client ${o.client_id} is not a Halcyon account`);
  if (o.client_sender && o.client_id && o.client_sender !== o.client_id) {
    add('client_mismatch', 'warning', 'client_id', `Body names ${o.client_id} but the email came from ${o.client_sender}'s domain`);
  }

  if (!o.unparseable) {
    if (!o.sku) add('missing_sku', 'error', 'sku', 'SKU is missing');
    else if (!SKU.test(o.sku)) add('invalid_sku', 'error', 'sku', `SKU "${o.sku}" is not a valid item code (e.g. HX-2201)`);
    if (o.quantity == null || o.quantity === '') add('missing_quantity', 'error', 'quantity', 'Quantity is missing');
    else if (!Number.isInteger(o.quantity) || o.quantity <= 0) add('invalid_quantity', 'error', 'quantity', `Quantity "${o.quantity}" must be a whole number above zero`);
    else if (o.quantity > MAX_REASONABLE_QTY) add('unusual_quantity', 'warning', 'quantity', `Quantity ${o.quantity} is unusually large`);
    if (o.commitment_type == null) add('unknown_service', 'warning', 'commitment_type', `Service "${o.service_raw}" not recognised; standard delivery applied`);

    if (!a.name) add('missing_name', 'error', 'ship_to.name', 'Recipient name is missing');
    if (!a.street) add('missing_street', 'error', 'ship_to.street', 'Street address is missing');
    else if (!/^\d+\w*\s+\S/.test(a.street)) add('missing_house_number', 'error', 'ship_to.street', `Street "${a.street}" has no house number`);
    if (!a.city) add('missing_city', 'error', 'ship_to.city', 'City is missing');
    if (!isUsState(a.state)) add('invalid_state', 'error', 'ship_to.state', a.state ? `"${a.state}" is not a US state` : 'State is missing');
    if (!/^\d{5}$/.test(a.zip || '')) add('invalid_zip', 'error', 'ship_to.zip', a.zip ? `ZIP "${a.zip}" is not 5 digits` : 'ZIP is missing');
    else if (isUsState(a.state) && !statesForZip(a.zip).includes(a.state)) {
      const owner = statesForZip(a.zip);
      add('zip_state_mismatch', 'error', 'ship_to.zip', `ZIP ${a.zip} is not a ${a.state} ZIP code`,
        `${owner.length ? `ZIP ${a.zip} belongs to ${owner.join('/')}` : `ZIP ${a.zip} is not a valid US ZIP`}; ${a.state} ZIPs start ${zipRangeText(a.state)}`);
    }

    if (o.requested_date && o.received_ts && o.requested_date < o.received_ts.slice(0, 10)) {
      add('requested_date_past', 'warning', 'requested_date', `Requested date ${o.requested_date} is before the order was received`);
    }
    if (otherClientsUsingRef.length) {
      add('duplicate_ref_other_client', 'warning', 'client_order_ref', `PO ${o.client_order_ref} is also used by ${otherClientsUsingRef.join(', ')}`);
    }
  }

  const decision = issues.some((i) => i.severity === 'fatal') ? 'reject'
    : issues.some((i) => i.severity === 'error') ? 'hold' : 'accept';
  return { decision, issues };
}
