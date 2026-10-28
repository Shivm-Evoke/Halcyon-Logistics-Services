// Shared statistics queried from the history and used by several routes.
import { q } from './db.js';

let carrierCache;
export async function carrierStats() {
  carrierCache ??= await q(`
    SELECT c.carrier_id, c.carrier_name, c.has_api, c.delivery_event_feed,
           c.preferred_supplier_agreement, c.base_rate_usd,
           count(*)                                   AS deliveries,
           avg(v.carrier_rate_usd)                    AS avg_rate,
           avg(v.is_late::int)                        AS late_rate,
           avg(v.is_late::int) FILTER (WHERE NOT (v.f_address OR v.f_cutoff OR v.f_stock)) AS clean_late_rate,
           avg(v.days_late) FILTER (WHERE v.is_late)  AS avg_days_late
    FROM v_deliveries v JOIN carriers c USING (carrier_id)
    GROUP BY c.carrier_id ORDER BY c.carrier_id`);
  return carrierCache;
}
