// Pure business rules for the fixes identified in the late-delivery analysis.
// No database access here, so every rule can be unit tested on its own.

export const PICK_LIST_CUTOFF = '08:00';
export const PENALTY_USD = 180;
export const REDELIVERY_USD = 34;
// Max late rate on clean orders a carrier may have to take time-critical work.
export const TIME_CRITICAL_MAX_LATE = 0.10;
// Calendar days from pick-list date to promised date, per commitment class (from the history).
export const CLASS_DAYS = { same_day: 1, next_day: 2, standard: 4 };

const STATE_REGION = {
  Midwest: 'IL IN IA KS MI MN MO NE ND OH SD WI',
  Southeast: 'AL AR FL GA KY LA MS NC SC TN VA WV TX OK',
  Northeast: 'CT DE DC MA MD ME NH NJ NY PA RI VT',
  West: 'AK AZ CA CO HI ID MT NM NV OR UT WA WY',
};
const invert = (m) => Object.fromEntries(Object.entries(m).flatMap(([k, v]) => v.split(' ').map((s) => [s, k])));
const REGION_OF = invert(STATE_REGION);
// 3-digit ZIP prefix ranges per state (USPS sectional centres). Far tighter than the first digit alone:
// a Virginia ZIP on a Maryland address shares the first digit but not the range.
export const ZIP_RANGES = {
  AL: [[350, 369]], AK: [[995, 999]], AZ: [[850, 865]], AR: [[716, 729]], CA: [[900, 961]], CO: [[800, 816]], CT: [[60, 69]],
  DE: [[197, 199]], DC: [[200, 205]], FL: [[320, 349]], GA: [[300, 319], [398, 399]], HI: [[967, 968]], ID: [[832, 838]],
  IL: [[600, 629]], IN: [[460, 479]], IA: [[500, 528]], KS: [[660, 679]], KY: [[400, 427]], LA: [[700, 714]], ME: [[39, 49]],
  MD: [[206, 219]], MA: [[10, 27], [55, 55]], MI: [[480, 499]], MN: [[550, 567]], MS: [[386, 397]], MO: [[630, 658]], MT: [[590, 599]],
  NE: [[680, 693]], NV: [[889, 898]], NH: [[30, 38]], NJ: [[70, 89]], NM: [[870, 884]], NY: [[5, 5], [100, 149]], NC: [[270, 289]],
  ND: [[580, 588]], OH: [[430, 459]], OK: [[730, 749]], OR: [[970, 979]], PA: [[150, 196]], RI: [[28, 29]], SC: [[290, 299]],
  SD: [[570, 577]], TN: [[370, 385]], TX: [[750, 799], [885, 885]], UT: [[840, 847]], VT: [[50, 59]], VA: [[201, 201], [220, 246]],
  WA: [[980, 994]], WV: [[247, 268]], WI: [[530, 549]], WY: [[820, 831]],
};
const prefixOf = (zip) => (/^\d{5}$/.test(zip || '') ? Number(zip.slice(0, 3)) : null);
/** States whose ZIP ranges contain this ZIP. */
export const statesForZip = (zip) => {
  const p = prefixOf(zip);
  return p == null ? [] : Object.keys(ZIP_RANGES).filter((st) => ZIP_RANGES[st].some(([lo, hi]) => p >= lo && p <= hi));
};
/** "206–219" style description of a state's ZIP ranges. */
export const zipRangeText = (state) => (ZIP_RANGES[state] || [])
  .map(([lo, hi]) => (lo === hi ? String(lo).padStart(3, '0') : `${String(lo).padStart(3, '0')}–${String(hi).padStart(3, '0')}`)).join(', ');
export const isUsState = (s) => Boolean(REGION_OF[s]);

const grab = (text, re) => text.match(re)?.[1]?.trim() || '';

// ---------- I1: email order intake ----------

export function parseEmailOrder(text) {
  const ship_to = {
    name: grab(text, /^[ \t]*(?:ship to|deliver to|attn|recipient)[ \t]*:?[ \t]*(.+)$/im),
    street: grab(text, /^[ \t]*(?:address|street|addr)[ \t]*:?[ \t]*(.+)$/im),
    city: grab(text, /^[ \t]*city[ \t]*:?[ \t]*(.+)$/im),
    state: grab(text, /^[ \t]*state[ \t]*:?[ \t]*([A-Za-z]{2})\b/im).toUpperCase(),
    zip: grab(text, /^[ \t]*(?:zip|postcode|postal code)[ \t]*:?[ \t]*(\d{5})/im),
  };
  // One-line form: "Deliver to: Name, 12 Street, City, ST 12345"
  const parts = ship_to.name.split(',').map((s) => s.trim());
  if (parts.length >= 4) {
    const m = parts[parts.length - 1].match(/^([A-Za-z]{2})\s+(\d{5})$/);
    Object.assign(ship_to, {
      name: parts[0], street: parts[1], city: parts[parts.length - 2],
      state: m ? m[1].toUpperCase() : '', zip: m ? m[2] : '',
    });
  }
  const qty = grab(text, /\b(?:qty|quantity|units)\b\s*[:#]?\s*(\d+)/i) || grab(text, /\bx\s*(\d+)\b/i);
  return {
    client_id: grab(text, /\b(?:account|customer|client)\b\s*[:#]?\s*(C\d{3})\b/i) || grab(text, /(?<![\w-])(C\d{3})(?![\w-])/),
    sku: grab(text, /\b(?:sku|item|product)\b\s*[:#]?\s*([A-Z0-9][A-Z0-9-]+)/i),
    quantity: qty ? Number(qty) : null,
    commitment_type: /same[\s-]?day/i.test(text) ? 'same_day'
      : /next[\s-]?day|overnight/i.test(text) ? 'next_day' : 'standard',
    ship_to,
  };
}

export function validateAddress({ name, street, city, state, zip } = {}) {
  const issues = [];
  if (!name) issues.push('Recipient name is missing');
  if (!street) issues.push('Street is missing');
  else if (!/^\d+\w*\s+\S/.test(street)) issues.push('Street has no house number');
  if (!city) issues.push('City is missing');
  if (!REGION_OF[state]) issues.push('State is missing or not a US state code');
  if (!/^\d{5}$/.test(zip || '')) issues.push('ZIP is missing or not 5 digits');
  else if (REGION_OF[state] && !statesForZip(zip).includes(state)) issues.push(`ZIP ${zip} does not match state ${state}`);
  return { issues, region: REGION_OF[state] || null };
}

// ---------- I2: cutoff-aware promise ----------

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/**
 * One promise rule for the gateway and the Wave Planner. A same-day order after the cutoff keeps its promise on the
 * second pick list when the warehouse still has room before that list closes; otherwise it ships tomorrow and is
 * re-promised next-day. Without `secondWaveAt` there is no second list (the rule the history was measured under).
 */
export function promiseDelivery({ receivedTs, commitmentType, secondWaveAt = null, wave2Room = false }) {
  const [date, time = '00:00'] = receivedTs.replace(' ', 'T').split('T');
  const hhmm = time.slice(0, 5);
  const afterCutoff = hhmm >= PICK_LIST_CUTOFF;
  const secondWave = Boolean(commitmentType === 'same_day' && afterCutoff && secondWaveAt && hhmm < secondWaveAt && wave2Room);
  const pickListDate = afterCutoff && !secondWave ? addDays(date, 1) : date;
  // Today's rule promises from the received date. Only same-day breaks, because an
  // after-cutoff order cannot be picked until tomorrow; promise from the pick list instead.
  const fixSameDay = commitmentType === 'same_day' && afterCutoff && !secondWave;
  const promisedDate = addDays(fixSameDay ? pickListDate : date, CLASS_DAYS[commitmentType]);
  return {
    afterCutoff,
    pickListDate,
    promisedDate,
    wave: !afterCutoff ? 1 : secondWave ? 2 : 'next',
    legacyPromisedDate: addDays(date, CLASS_DAYS[commitmentType]),
    offeredCommitment: fixSameDay ? 'next_day' : commitmentType,
    note: secondWave
      ? `After the ${PICK_LIST_CUTOFF} cutoff: joins the ${secondWaveAt} second pick list, so same-day is kept.`
      : fixSameDay
        ? `Received after the ${PICK_LIST_CUTOFF} pick-list cutoff, so it ships tomorrow. Offer next-day (${promisedDate}) instead of same-day.`
        : afterCutoff ? `After cutoff: goes on the ${pickListDate} pick list; promise still achievable.`
          : `Makes today's ${PICK_LIST_CUTOFF} pick list.`,
  };
}

// ---------- I4: performance-weighted carrier choice ----------

export function rankCarriers(stats, { slaClient, commitmentType }) {
  const lateCost = REDELIVERY_USD + (slaClient ? PENALTY_USD : 0);
  const timeCritical = commitmentType !== 'standard';
  return stats
    .map((c) => ({
      ...c,
      expected_cost: Number(c.avg_rate) + Number(c.clean_late_rate) * lateCost,
      eligible: !timeCritical || Number(c.clean_late_rate) <= TIME_CRITICAL_MAX_LATE,
    }))
    .sort((a, b) => (b.eligible - a.eligible) || (a.expected_cost - b.expected_cost));
}

// ---------- I6: what-if simulator ----------
// groups: rows of { f_address, f_cutoff, f_stock, has_api, n, late, penalties, redelivery }.
// A fixed failure mode is assumed to perform like clean orders on the same carrier type.
export function whatIf(groups, fix = {}) {
  const rate = (pred) => {
    const g = groups.filter(pred);
    const n = g.reduce((s, x) => s + x.n, 0);
    return n ? g.reduce((s, x) => s + x.late, 0) / n : 0;
  };
  const clean = (x) => !x.f_address && !x.f_cutoff && !x.f_stock;
  const apiClean = rate((x) => clean(x) && x.has_api);
  const nonApiClean = rate((x) => clean(x) && !x.has_api);

  let n = 0; let late = 0; let penalties = 0; let redelivery = 0;
  for (const g of groups) {
    const blocked = (g.f_address && !fix.address) || (g.f_cutoff && !fix.cutoff) || (g.f_stock && !fix.stock);
    let after = g.late;
    if (!blocked) {
      const apiLike = g.has_api || fix.carrier;
      const changed = !clean(g) || (!g.has_api && fix.carrier);
      if (changed) after = g.n * (apiLike ? apiClean : nonApiClean);
      // Best case for routing: it removes the residual lateness of clean, API-tracked orders.
      if (fix.routing && apiLike) after = Math.max(0, after - g.n * apiClean);
    }
    const scale = g.late ? after / g.late : 0;
    n += g.n; late += after; penalties += g.penalties * scale; redelivery += g.redelivery * scale;
  }
  return { deliveries: n, late, onTimeRate: (n - late) / n, penalties, redelivery };
}
