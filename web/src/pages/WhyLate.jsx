import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { TrendingDown, DollarSign, Users, Clock, ArrowRight } from 'lucide-react';
import { ResponsiveContainer } from '../components/motion.jsx';
import { useApi, pct, num, usdK, PAL } from '../api.js';
import { PageHead, Card, Kpi, Loading } from '../components/ui.jsx';
import { axisX, axisY, gridProps, barProps, tip } from '../components/charts.jsx';

const mean = (rows, f) => rows.reduce((s, r) => s + f(r) * r.orders, 0) / rows.reduce((s, r) => s + r.orders, 0);

export default function WhyLate() {
  const { data, error } = useApi('/agents/causes');
  if (!data) return <Loading error={error} />;
  const { base, cutoff, carriers, friday, address, stock, routing, money } = data;
  const good = carriers.filter((c) => ['A', 'B', 'C'].includes(c.carrier_id));
  const weak = carriers.filter((c) => ['D', 'E', 'F'].includes(c.carrier_id));
  const [before8, after8] = [cutoff.find((c) => !c.after_cutoff), cutoff.find((c) => c.after_cutoff)];
  const [otherDays, fri] = [friday.find((f) => !f.friday), friday.find((f) => f.friday)];
  const email = address.find((a) => a.order_channel === 'Email');
  const machine = address.filter((a) => a.order_channel !== 'Email');
  const [missed, stocked] = [stock.find((s) => s.had_stock === 'N'), stock.find((s) => s.had_stock === 'Y')];

  const causes = [
    { n: 1, cause: 'Slow carriers on easy routes', agent: 'Carrier',
      evidence: `On clean orders under 300 miles, A, B and C are ${pct(mean(good, (c) => c.on_time), 0)} on time; ${weak.map((c) => `${c.carrier_id} ${pct(c.on_time, 0)}`).join(', ')}.`,
      hit: `${num(weak.reduce((s, c) => s + c.orders, 0))} clean orders on D, E, F` },
    { n: 2, cause: 'Friday overflow onto carrier D', agent: 'Carrier',
      evidence: `${pct(fri.share_d, 0)} of Friday orders go to D (${pct(otherDays.share_d, 0)} on other days); Friday on-time ${pct(fri.on_time)}.`,
      hit: `${num(fri.orders)} Friday orders` },
    { n: 3, cause: 'Pick list closes at 08:00, trucks collect from 14:00', agent: 'Wave Planner',
      evidence: `Same-day orders received after 08:00 are ${pct(after8.on_time, 0)} on time; before 08:00, ${pct(before8.on_time, 0)}.`,
      hit: `${num(after8.orders)} same-day orders` },
    { n: 4, cause: 'Incomplete addresses from email orders', agent: 'Intake',
      evidence: `${pct(email.incomplete_share, 1)} of email orders arrive incomplete against ${pct(mean(machine, (a) => a.incomplete_share), 0)} by API or EDI; incomplete orders are ${pct(mean(address, (a) => a.on_time_incomplete ?? 0), 0)} on time.`,
      hit: `${num(address.reduce((s, a) => s + a.orders * a.incomplete_share, 0))} orders` },
    { n: 5, cause: 'Stock not at the nearest warehouse', agent: 'Stock',
      evidence: `A miss ships from ${num(missed.miles)} miles instead of ${num(stocked.miles)}; ${pct(missed.on_time, 0)} on time.`,
      hit: `${num(missed.orders)} orders` },
  ];
  const overPlan = routing.reduce((s, r) => s + Number(r.actual_vs_planned), 0) / routing.length - 1;
  const routingData = routing.map((r) => ({ label: `${r.min_stops}–${r.max_stops} stops`, on_time: r.on_time, ratio: r.actual_vs_planned }));

  return (
    <>
      <PageHead title="Why we're late" eyebrow="The problem · 48,340 deliveries, Apr–Sep 2026">
        Five causes, each measured on the deliveries themselves. All five happen before or at the warehouse, and each has an agent
        that fixes it. Route planning, which the routing product would change, makes no measurable difference.
      </PageHead>

      <div className="grid g4 section-gap">
        <Kpi icon={TrendingDown} label="On-time delivery" value={pct(base.on_time)} sub="Industry benchmark 94%" tone="bad" bar={base.on_time} />
        <Kpi icon={DollarSign} label="Penalties and redelivery" value={usdK(Number(money.penalties) + Number(money.redelivery))} sub="Six months" tone="warn" />
        <Kpi icon={Users} label="Revenue threatening to leave" value={usdK(money.at_risk_revenue)} sub={`${money.at_risk_clients} accounts`} tone="bad" />
        <Kpi icon={Clock} label="Customer success on complaints" value={pct(money.complaint_hours / money.cs_hours, 0)} sub={`${num(money.complaint_hours)} of ${num(money.cs_hours)} hours a week`} />
      </div>

      <div className="table-wrap section-gap">
        <table>
          <thead><tr><th>#</th><th>Cause</th><th>Evidence</th><th>Orders hit</th><th>Fixed by</th></tr></thead>
          <tbody>
            {causes.map((c) => (
              <tr key={c.n}>
                <td className="num-tab">{c.n}</td><td style={{ whiteSpace: 'normal', minWidth: 180 }}><b>{c.cause}</b></td><td style={{ whiteSpace: 'normal', minWidth: 320 }}>{c.evidence}</td><td className="num-tab" style={{ whiteSpace: 'normal' }}>{c.hit}</td>
                <td><Link to="/agents">{c.agent} agent <ArrowRight size={11} /></Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid g3 section-gap">
        <Card title="Routing is not the problem" sub="Clean orders: on-time by stops on the route." className="span2">
          <ResponsiveContainer height={220}>
            <BarChart data={routingData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="label" {...axisX} />
              <YAxis {...axisY} domain={[0, 1]} tickFormatter={(v) => pct(v, 0)} />
              {tip((v) => pct(v))}
              <Bar dataKey="on_time" name="On time" fill={PAL.series[0]} {...barProps} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="What that means" sub="For the routing product leadership is about to buy.">
          <p>On-time stays at {pct(Math.min(...routing.map((r) => r.on_time)), 0)}–{pct(Math.max(...routing.map((r) => r.on_time)), 0)} whether a route has 6 stops or 40,
            and trucks drive {pct(overPlan, 0)} over the planned distance on every route, on time or late.</p>
          <p className="muted small">Better routes cannot fix orders that leave late, leave from the wrong warehouse, or go with a slow carrier.</p>
        </Card>
      </div>
    </>
  );
}
