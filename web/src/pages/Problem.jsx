// Staff: the problem in one screen: the on-time headline against the benchmark and the five measured causes.
import { TrendingDown, DollarSign } from 'lucide-react';
import { useApi, pct, num, usdK } from '../api.js';
import { PageHead, Kpi, Loading } from '../components/ui.jsx';

const mean = (rows, f) => rows.reduce((s, r) => s + f(r) * r.orders, 0) / rows.reduce((s, r) => s + r.orders, 0);

/** The five causes, each with the evidence and the number of orders it hits (same measurements as the causes endpoint). */
function causesOf({ cutoff, carriers, friday, address, stock }) {
  const good = carriers.filter((c) => ['A', 'B', 'C'].includes(c.carrier_id));
  const weak = carriers.filter((c) => ['D', 'E', 'F'].includes(c.carrier_id));
  const [before8, after8] = [cutoff.find((c) => !c.after_cutoff), cutoff.find((c) => c.after_cutoff)];
  const [otherDays, fri] = [friday.find((f) => !f.friday), friday.find((f) => f.friday)];
  const email = address.find((a) => a.order_channel === 'Email');
  const machine = address.filter((a) => a.order_channel !== 'Email');
  const [missed, stocked] = [stock.find((s) => s.had_stock === 'N'), stock.find((s) => s.had_stock === 'Y')];
  return [
    { cause: 'Slow carriers on easy routes',
      evidence: `On clean orders under 300 miles, A, B and C are ${pct(mean(good, (c) => c.on_time), 0)} on time; ${weak.map((c) => `${c.carrier_id} ${pct(c.on_time, 0)}`).join(', ')}.`,
      hit: `${num(weak.reduce((s, c) => s + c.orders, 0))} clean orders on D, E, F` },
    { cause: 'Friday overflow onto carrier D',
      evidence: `${pct(fri.share_d, 0)} of Friday orders go to D (${pct(otherDays.share_d, 0)} on other days); Friday on-time ${pct(fri.on_time)}.`,
      hit: `${num(fri.orders)} Friday orders` },
    { cause: 'Pick list closes at 08:00, trucks collect from 14:00',
      evidence: `Same-day orders received after 08:00 are ${pct(after8.on_time, 0)} on time; before 08:00, ${pct(before8.on_time, 0)}.`,
      hit: `${num(after8.orders)} same-day orders` },
    { cause: 'Incomplete addresses from email orders',
      evidence: `${pct(email.incomplete_share, 1)} of email orders arrive incomplete against ${pct(mean(machine, (a) => a.incomplete_share), 0)} by API or EDI; incomplete orders are ${pct(mean(address, (a) => a.on_time_incomplete ?? 0), 0)} on time.`,
      hit: `${num(address.reduce((s, a) => s + a.orders * a.incomplete_share, 0))} orders` },
    { cause: 'Stock not at the nearest warehouse',
      evidence: `A miss ships from ${num(missed.miles)} miles instead of ${num(stocked.miles)}; ${pct(missed.on_time, 0)} on time.`,
      hit: `${num(missed.orders)} orders` },
  ];
}

/** @returns the problem screen */
export default function Problem() {
  const { data, error } = useApi('/agents/causes');
  if (!data) return <Loading error={error} />;
  const { base, money } = data;
  return (
    <>
      <PageHead title="The problem" eyebrow="48,340 deliveries, Apr–Sep 2026">
        Halcyon delivers {pct(base.on_time)} of orders on time against an industry benchmark of 94%. Five causes explain it, each
        measured on the deliveries themselves, and all five happen before or at the warehouse.
      </PageHead>

      <div className="grid g2 section-gap">
        <Kpi icon={TrendingDown} label="On-time delivery" value={pct(base.on_time)} sub="Industry benchmark 94%" tone="bad" bar={base.on_time} />
        <Kpi icon={DollarSign} label="Penalties and redelivery" value={usdK(Number(money.penalties) + Number(money.redelivery))} sub="Cost of the late deliveries, six months" tone="warn" />
      </div>

      <div className="table-wrap section-gap">
        <table>
          <thead><tr><th>#</th><th>Cause</th><th>Evidence</th><th>Orders hit</th></tr></thead>
          <tbody>
            {causesOf(data).map((c, i) => (
              <tr key={c.cause}>
                <td className="num-tab">{i + 1}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 180 }}><b>{c.cause}</b></td>
                <td style={{ whiteSpace: 'normal', minWidth: 320 }}>{c.evidence}</td>
                <td className="num-tab" style={{ whiteSpace: 'normal' }}>{c.hit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
