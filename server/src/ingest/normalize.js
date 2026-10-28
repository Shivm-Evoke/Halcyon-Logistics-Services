// Normalise a raw order record from any channel into the canonical order, fixing the
// predictable formatting errors automatically. Every change is recorded so it can be audited
// and reported back to the client.

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

// Matched anywhere in the text ("same day please", "OVERNIGHT delivery"); first match wins.
const SERVICE_SYNONYMS = [
  [/\b(same[\s_-]?day|sameday|sd|today|urgent|asap|rush)\b/i, 'same_day'],
  [/\b(next[\s_-]?day|nextday|nd|overnight|express|priority|24h|1[\s-]?day)\b/i, 'next_day'],
  [/\b(standard|std|ground|economy|regular|normal|3[\s-]?5[\s-]?days?)\b/i, 'standard'],
];
// "Next Day", "NEXT-DAY" and "next_day" are the canonical value written differently, not a correction.
const isCanonicalSpelling = (raw, canonical) => raw.toLowerCase().replace(/[\s-]+/g, '_') === canonical;

const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
const tidy = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
// Only re-case text typed all upper or all lower; leave deliberate mixed case (McDonald) alone.
const recase = (s) => (s && (s === s.toUpperCase() || s === s.toLowerCase()) ? titleCase(s) : s);

export function normalizeOrder(rec) {
  const corrections = [];
  const fix = (field, from, to, rule) => {
    if (String(from ?? '') !== String(to ?? '')) corrections.push({ field, from: from ?? null, to, rule });
    return to;
  };

  // Client: "c55" / "C 055" -> "C055".
  const rawClient = tidy(rec.client_hint);
  const cm = rawClient.match(/^c\s*0*(\d{1,3})$/i);
  const client_id = fix('client_id', rawClient, cm ? `C${cm[1].padStart(3, '0')}` : rawClient.toUpperCase(), 'client id format');

  // SKU: " hx 2201 " / "HX2201" / "hx_2201" -> "HX-2201".
  const rawSku = tidy(rec.sku);
  const sm = rawSku.toUpperCase().replace(/[\s_]+/g, '-').match(/^([A-Z]{2,4})-*(\d+)$/);
  const sku = fix('sku', rawSku, sm ? `${sm[1]}-${sm[2]}` : rawSku.toUpperCase(), 'SKU format');

  // Quantity: "40 units" -> 40. Non-numeric stays as-is for validation to reject.
  let quantity = rec.quantity;
  if (typeof quantity === 'string') {
    const qm = quantity.trim().match(/^(-?\d+)(?:\.0+)?\s*(units?|pcs?|pieces|ea|each|x)?$/i);
    quantity = qm ? fix('quantity', rec.quantity, Number(qm[1]), 'quantity text to number') : tidy(quantity) || null;
  }

  // Service level: synonyms -> canonical commitment type.
  const rawService = tidy(rec.service);
  const match = SERVICE_SYNONYMS.find(([re]) => re.test(rawService.replace(/_/g, ' ')));
  let commitment_type = rawService ? null : 'standard';
  if (match) {
    commitment_type = isCanonicalSpelling(rawService, match[1]) ? match[1] : fix('commitment_type', rawService, match[1], 'service synonym');
  }

  // Address.
  const s = rec.ship_to || {};
  const name = fix('ship_to.name', s.name, recase(tidy(s.name)), 'formatting');
  const street = fix('ship_to.street', s.street, recase(tidy(s.street)), 'formatting');
  const city = fix('ship_to.city', s.city, recase(tidy(s.city)), 'formatting');
  const rawState = tidy(s.state);
  const state = fix('ship_to.state', s.state, STATE_NAMES[rawState.toLowerCase().replace(/\.$/, '')] || rawState.toUpperCase(), 'state name to code');
  let zip = tidy(s.zip).replace(/\s/g, '');
  const plus4 = zip.match(/^(\d{5})-?\d{4}$/);
  if (plus4) zip = fix('ship_to.zip', s.zip, plus4[1], 'ZIP+4 to 5 digits');
  else if (/^\d{3,4}$/.test(zip)) zip = fix('ship_to.zip', s.zip, zip.padStart(5, '0'), 'restore leading zeros dropped by spreadsheet');
  else zip = fix('ship_to.zip', s.zip, zip, 'formatting');

  return {
    order: {
      client_id,
      client_sender: rec.client_sender || '',
      client_order_ref: tidy(rec.client_order_ref) || null,
      sku,
      quantity,
      commitment_type,
      service_raw: rawService || null,
      requested_date: rec.requested_date || null,
      received_ts: rec.received_ts || null,
      ship_to: { name, street, city, state, zip },
      unparseable: Boolean(rec.unparseable),
      structural_errors: rec.structural_errors || [],
      source_ref: rec.source_ref || null,
    },
    corrections,
  };
}
