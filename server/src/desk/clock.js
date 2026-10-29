// The desk's ops clock and stage timing. Pure: times are local 'YYYY-MM-DD HH:MM' strings, handled as UTC-naive
// so the server's time zone never shifts them.
const MIN = 60000;
const DEFAULT_SET_TO = '2026-09-25 09:15';
const EVENTS = ['08:00', '13:00', '14:00', '23:59'];
const ORDER = ['received', 'picked', 'collected', 'in_transit', 'delivered'];

const pad = (n) => String(n).padStart(2, '0');
const parse = (s) => new Date(`${String(s).replace(' ', 'T').slice(0, 16)}:00Z`);
const fmt = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
const addDays = (date, n) => fmt(new Date(parse(`${date} 00:00`).getTime() + n * 86400000)).slice(0, 10);
// A timestamp column may arrive as a Date (read by pg in server-local time) or as a string.
const localTs = (v) => v instanceof Date
  ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}`
  : String(v).replace('T', ' ').slice(0, 16);

/**
 * The ops clock: `set_to` plus the real time elapsed since `set_at`.
 * @param row desk_clock row or null (null gives the default start, 2026-09-25 09:15)
 * @param realNow Date
 * @returns 'YYYY-MM-DD HH:MM'
 */
export function clockNow(row, realNow) {
  const setTo = localTs(row?.set_to ?? DEFAULT_SET_TO);
  const setAt = row?.set_at ? new Date(row.set_at) : realNow;
  return fmt(new Date(parse(setTo).getTime() + Math.max(0, realNow - setAt)));
}

/** The run's id, `desk-<date the run started at>-<run_no>`; moving the clock on (even past midnight) keeps it. */
export const runIdOf = (row) => `desk-${localTs(row.run_from ?? row.set_to).slice(0, 10)}-${row.run_no}`;

/** The next checkpoint (08:00, 13:00, 14:00, 23:59) after `now`, else 08:00 the next day. */
export function nextEvent(now) {
  const ts = localTs(now);
  const date = ts.slice(0, 10);
  const hit = EVENTS.find((t) => `${date} ${t}` > ts);
  return hit ? `${date} ${hit}` : `${addDays(date, 1)} 08:00`;
}

/**
 * The stage an order should be at by `now`.
 * @param order { stage, wave (1|2|null), commitment_type, promised_date, received_ts }
 * @returns the stage; on_hold, cancelled and anything later than due are left as they are
 */
export function dueStage(order, now) {
  const { stage } = order;
  if (!ORDER.includes(stage)) return stage;
  const t = localTs(now);
  const received = localTs(order.received_ts);
  const pickDay = order.wave ? received.slice(0, 10) : addDays(received.slice(0, 10), 1);
  const pickAt = `${pickDay} ${order.wave === 2 ? '13:00' : '08:00'}`;
  const collectAt = `${pickDay} 14:00`;
  const deliverAt = `${localTs(order.promised_date).slice(0, 10)} 23:59`;
  let due = 'received';
  if (t >= pickAt) due = 'picked';
  if (t >= collectAt) due = 'collected';
  if (t > collectAt) due = 'in_transit';
  if (t >= deliverAt) due = 'delivered';
  return ORDER.indexOf(due) > ORDER.indexOf(stage) ? due : stage;
}
