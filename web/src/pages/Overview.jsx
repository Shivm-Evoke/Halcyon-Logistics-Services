import { Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine, BarChart, Bar, Cell } from 'recharts';
import { ResponsiveContainer, anim } from '../components/motion.jsx';
import { TrendingDown, AlertTriangle, DollarSign, Users, MessageSquareWarning, ArrowRight, Lightbulb } from 'lucide-react';
import { useApi, pct, usdK, num, CAUSES, PAL } from '../api.js';
import { PageHead, Card, Kpi, Loading, Meter } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, gridProps, barProps, tip, Legend, Donut } from '../components/charts.jsx';

const FIX_LINKS = { address: '/inbound', cutoff: '/diagnosis', stock: '/inventory', carrier: '/carriers', residual: '/what-if' };
const monthLabel = (m) => new Date(`${m}-01T00:00`).toLocaleString('en-US', { month: 'short' });

export default function Overview() {
  const { data, error } = useApi('/overview');
  if (!data) return <Loading error={error} />;
  const { kpis, monthly, causes, byRegion, byWarehouse, cs, carriers } = data;
  const totalLate = causes.reduce((s, c) => s + c.late, 0);
  const upstream = causes.filter((c) => c.cause !== 'residual').reduce((s, c) => s + c.late, 0);
  const csRows = [
    { name: 'Delivery complaints', hours: cs.complaints, color: PAL.series[1] },
    { name: 'Keying email orders', hours: cs.keying, color: PAL.series[3] },
    { name: 'Proactive client work', hours: cs.proactive, color: PAL.series[2] },
    { name: 'Other', hours: cs.total - cs.complaints - cs.keying - cs.proactive, color: PAL.neutral },
  ];

  return (
    <>
      <PageHead title="Executive overview" eyebrow="Six months · 1 April – 25 September 2026">
        On-time delivery has been flat at about 71% every month. This is a chronic process problem, not a recent routing failure,
        and almost all of it starts before a truck is loaded.
      </PageHead>

      <div className="grid g6 section-gap">
        <Kpi icon={TrendingDown} label="On-time delivery" value={pct(kpis.on_time_rate)} sub="Industry benchmark 94%" tone="bad" bar={kpis.on_time_rate} />
        <Kpi icon={AlertTriangle} label="Late deliveries" value={num(kpis.late)} sub={`of ${num(kpis.deliveries)} shipped`} />
        <Kpi icon={DollarSign} label="SLA penalties" value={usdK(kpis.penalties)} sub="$180 per late SLA order" tone="warn" />
        <Kpi icon={DollarSign} label="Redelivery cost" value={usdK(kpis.redelivery)} sub="Six months" />
        <Kpi icon={Users} label="Revenue at risk" value={usdK(kpis.at_risk_revenue)} sub={`${kpis.at_risk_accounts} accounts threatening to leave`} tone="bad" />
        <Kpi icon={MessageSquareWarning} label="Formal complaints" value={kpis.complaints} sub="Last 90 days" />
      </div>

      <div className="callout section-gap">
        <Lightbulb size={18} />
        <div>
          <b>{pct(upstream / totalLate, 0)} of late deliveries are decided before the truck leaves</b>: at order intake, promise setting,
          stock placement and carrier choice. Only {pct(1 - upstream / totalLate, 0)} are left for a routing engine.{' '}
          <Link to="/what-if">See the vendor decision <ArrowRight size={13} style={{ verticalAlign: -2 }} /></Link>
        </div>
      </div>

      <div className="grid g3 section-gap">
        <Card className="span2" title="On-time delivery by month" sub="The gap to the 94% benchmark has not moved in six months.">
          <ResponsiveContainer width="100%" height={372}>
            <AreaChart data={monthly} margin={{ top: 12, right: 12, left: -6, bottom: 0 }}>
              <defs>
                <linearGradient id="ontime" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PAL.series[0]} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={PAL.series[0]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="month" tickFormatter={monthLabel} {...axisX} />
              <YAxis domain={[0.6, 1]} tickFormatter={(v) => pct(v, 0)} {...axisY} />
              {tip((v) => pct(v), (m) => new Date(`${m}-01T00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' }))}
              <ReferenceLine y={0.94} stroke={PAL.benchmark} strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: 'Benchmark 94%', fill: PAL.benchmark, fontSize: 12, position: 'insideTopRight' }} />
              <Area dataKey="on_time_rate" name="On-time" type="monotone" stroke={PAL.series[0]} strokeWidth={2} fill="url(#ontime)" {...anim}
                dot={{ r: 3.5, strokeWidth: 2, stroke: PAL.surface, fill: PAL.series[0] }} activeDot={{ r: 5, stroke: PAL.surface, strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Why deliveries are late" sub="Each late delivery counted once, in priority order.">
          <Donut data={causes.map((c) => ({ name: CAUSES[c.cause].label, value: c.late, color: CAUSES[c.cause].hex }))}
            centerValue={num(totalLate)} centerLabel="late deliveries" format={(v) => `${num(v)} · ${pct(v / totalLate)}`} />
          <ul className="list-clean small" style={{ marginTop: 12 }}>
            {causes.map((c) => (
              <li key={c.cause} style={{ alignItems: 'center' }}>
                <span className="dot" style={{ background: CAUSES[c.cause].color }} />
                <Link to={FIX_LINKS[c.cause]} style={{ color: 'inherit', flex: 1 }}>{CAUSES[c.cause].label}</Link>
                <b className="num-tab">{pct(c.late / totalLate)}</b>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid g3 section-gap">
        <Card title="Routing check: late rate is flat everywhere" sub="If routes were the problem, regions and warehouses would differ. They sit within 1.5 points of each other.">
          <div className="small muted" style={{ marginBottom: 8 }}>By destination region</div>
          <FlatBars rows={byRegion} />
          <div className="small muted" style={{ margin: '16px 0 8px' }}>By shipping warehouse</div>
          <FlatBars rows={byWarehouse} />
        </Card>
        <Card title="Late rate by carrier" sub="The three carriers without a tracking API are the outliers.">
          <Legend items={[{ label: 'API feed (A, B, C)', color: PAL.series[0] }, { label: 'Portal / batch file (D, E, F)', color: PAL.series[1] }]} />
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={carriers} margin={{ top: 18, right: 4, left: -10, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="carrier_id" interval={0} {...axisX} />
              <YAxis tickFormatter={(v) => pct(v, 0)} {...axisY} />
              {tip((v) => pct(v), (c) => `Carrier ${c}`)}
              <Bar dataKey="late_rate" name="Late rate" {...barProps} label={{ position: 'top', fontSize: 12, fill: PAL.ink2, formatter: (v) => pct(v, 0) }}>
                {carriers.map((c) => <Cell key={c.carrier_id} fill={c.has_api === 'Y' ? PAL.series[0] : PAL.series[1]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Where the customer success week goes" sub={`Time study: 18 staff, ${num(cs.total)} hours.`}>
          <div style={{ display: 'flex', height: 14, borderRadius: 0, overflow: 'hidden', gap: 2, marginBottom: 18 }}>
            {csRows.map((r) => <span key={r.name} title={`${r.name}: ${pct(r.hours / cs.total, 0)}`} style={{ width: `${(r.hours / cs.total) * 100}%`, background: r.color }} />)}
          </div>
          <ul className="list-clean small">
            {csRows.map((r) => (
              <li key={r.name} style={{ alignItems: 'center' }}>
                <span className="dot" style={{ background: r.color }} /><span style={{ flex: 1 }}>{r.name}</span>
                <span className="muted num-tab">{num(r.hours)} h</span><b className="num-tab" style={{ width: 44, textAlign: 'right' }}>{pct(r.hours / cs.total, 0)}</b>
              </li>
            ))}
          </ul>
          <p className="small muted" style={{ margin: '12px 0 0' }}>Two-thirds of the team's week goes on reacting to late deliveries instead of looking after clients.</p>
        </Card>
      </div>

      <Card title="Cost of late deliveries by cause" sub="SLA penalties and redelivery over six months. Each cause links to the screen that fixes it.">
        <DataTable compact rows={causes} rowKey={(r) => r.cause} initialSort={{ key: 'late', dir: 'desc' }}
          columns={[
            { key: 'cause', label: 'Cause', filter: false, value: (r) => CAUSES[r.cause].label,
              render: (r) => <Link to={FIX_LINKS[r.cause]} className="row" style={{ color: 'inherit', gap: 8 }}><span className="dot" style={{ background: CAUSES[r.cause].color }} />{CAUSES[r.cause].label}</Link> },
            { key: 'issue', label: 'Issue', filter: false, value: (r) => CAUSES[r.cause].issue, render: (r) => <span className="mono muted">{CAUSES[r.cause].issue}</span> },
            { key: 'late', label: 'Late deliveries', align: 'num', render: (r) => num(r.late) },
            { key: 'share', label: 'Share', align: 'num', value: (r) => r.late / totalLate, render: (r) => pct(r.late / totalLate) },
            { key: 'penalties', label: 'Penalties', align: 'num', render: (r) => usdK(r.penalties) },
            { key: 'redelivery', label: 'Redelivery', align: 'num', render: (r) => usdK(r.redelivery) },
          ]} />
      </Card>
    </>
  );
}

function FlatBars({ rows }) {
  return (
    <div className="stack">
      {rows.map((r) => (
        <div key={r.name}>
          <div className="row between small" style={{ marginBottom: 4 }}><span>{r.name}</span><b className="num-tab">{pct(r.late_rate)}</b></div>
          <Meter value={r.late_rate} max={0.5} color={PAL.series[0]} />
        </div>
      ))}
    </div>
  );
}
