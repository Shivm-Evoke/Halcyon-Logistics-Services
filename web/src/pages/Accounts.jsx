import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, ScatterChart, Scatter, ZAxis, Tooltip } from 'recharts';
import { ResponsiveContainer, anim } from '../components/motion.jsx';
import { X, MessageSquareWarning, Bell, Wrench, Users, TrendingDown, MessageSquare, DollarSign } from 'lucide-react';
import { useApi, pct, num, usd, usdK, CAUSES, PAL } from '../api.js';
import { PageHead, Card, Badge, Loading, Kpi, Meter, CauseTag } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, gridProps, lineProps, ChartTip, Legend } from '../components/charts.jsx';

const SEGMENTS = [['at_risk', 'Threatening to leave'], ['Tier 1', 'Tier 1'], ['Tier 2', 'Tier 2'], ['Tier 3', 'Tier 3'], ['all', 'All accounts']];

export default function Accounts() {
  const { data, error } = useApi('/accounts');
  const [status, setStatus] = useState('at_risk');
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => (data || []).filter((a) => status === 'all'
    || (status === 'at_risk' ? a.account_status === 'threatening_to_leave' : a.account_tier === status)), [data, status]);
  if (!data) return <Loading error={error} />;
  const atRisk = data.filter((a) => a.account_status === 'threatening_to_leave');
  const others = data.filter((a) => a.account_status !== 'threatening_to_leave');
  const avg = (xs, k) => xs.reduce((s, x) => s + Number(x[k]), 0) / xs.length;
  const point = (a) => ({ x: a.annual_revenue_usd, y: Number(a.late_rate), z: a.complaints + 1, name: a.client_name, id: a.client_id });

  return (
    <>
      <PageHead title="Account health" eyebrow="Clients · I9 · $14.2M threatening to leave">
        The nine accounts threatening to leave get the same service as everyone else (about 29% late) but raise most of the complaints.
        They need visibility and a recovery plan, not a different route.
      </PageHead>

      <div className="grid g4 section-gap">
        <Kpi icon={Users} label="Revenue threatening to leave" value={usdK(atRisk.reduce((s, a) => s + a.annual_revenue_usd, 0))} sub={`${atRisk.length} accounts, ${atRisk.filter((a) => a.account_tier === 'Tier 1').length} of them Tier 1`} tone="bad" />
        <Kpi icon={TrendingDown} label="Late rate, at-risk accounts" value={pct(avg(atRisk, 'late_rate'))} sub={`vs ${pct(avg(others, 'late_rate'))} for every other account`} />
        <Kpi icon={MessageSquare} label="Complaints from at-risk accounts" value={`${atRisk.reduce((s, a) => s + a.complaints, 0)} of ${data.reduce((s, a) => s + a.complaints, 0)}`} sub="Last 90 days" tone="warn" bar={atRisk.reduce((s, a) => s + a.complaints, 0) / data.reduce((s, a) => s + a.complaints, 0)} />
        <Kpi icon={DollarSign} label="Penalties paid to at-risk accounts" value={usdK(atRisk.reduce((s, a) => s + a.penalties, 0))} sub="Six months" />
      </div>

      <Card title="Revenue against late rate, all 280 accounts" className="section-gap"
        sub="Every dot is an account; bigger dots raised more complaints. The at-risk accounts are not served worse, they are simply the biggest and the loudest. Click a dot to open the account.">
        <Legend items={[{ label: 'Threatening to leave', color: PAL.series[1] }, { label: 'Other accounts', color: PAL.neutral }]} />
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart margin={{ top: 14, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid {...gridProps} vertical />
            <XAxis type="number" dataKey="x" name="Annual revenue" domain={[0, 2400000]} ticks={[0, 400000, 800000, 1200000, 1600000, 2000000, 2400000]} tickFormatter={(v) => usdK(v)} {...axisX} />
            <YAxis type="number" dataKey="y" name="Late rate" domain={[0.15, 0.45]} ticks={[0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45]} tickFormatter={(v) => pct(v, 0)} {...axisY} />
            <ZAxis type="number" dataKey="z" range={[40, 360]} />
            <Tooltip cursor={{ strokeDasharray: '0', stroke: PAL.base }} content={({ active, payload }) => (active && payload?.length ? (
              <ChartTip active payload={[{ name: 'Late rate', value: payload[0].payload.y, color: PAL.muted }, { name: 'Revenue', value: payload[0].payload.x, color: PAL.muted }, { name: 'Complaints', value: payload[0].payload.z - 1, color: PAL.muted }]}
                title={() => payload[0].payload.name} format={(v, n) => (n === 'Late rate' ? pct(v) : n === 'Revenue' ? usdK(v) : v)} />) : null)} />
            <Scatter data={others.map(point)} fill={PAL.neutral} fillOpacity={0.7} stroke={PAL.surface} strokeWidth={1.5} {...anim} onClick={(p) => setOpen(p.id)} cursor="pointer" />
            <Scatter data={atRisk.map(point)} fill={PAL.series[1]} stroke={PAL.surface} strokeWidth={2} {...anim} onClick={(p) => setOpen(p.id)} cursor="pointer" />
          </ScatterChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Accounts" sub="Click a row for the account's failure pattern, complaints and recovery plan.">
        <DataTable rows={rows} rowKey={(r) => r.client_id} onRowClick={(a) => setOpen(a.client_id)} pageSize={25} exportName="accounts" searchPlaceholder="Search accounts"
          toolbar={<div className="seg">{SEGMENTS.map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>}
          columns={[
            { key: 'client_name', label: 'Client', render: (a) => <><b>{a.client_name}</b> <span className="mono muted">{a.client_id}</span></> },
            { key: 'account_tier', label: 'Tier', filter: 'select' },
            { key: 'region', label: 'Region', filter: 'select' },
            { key: 'primary_order_channel', label: 'Channel', filter: 'select' },
            { key: 'annual_revenue_usd', label: 'Revenue', align: 'num', filter: 'range', render: (a) => usdK(a.annual_revenue_usd) },
            { key: 'late_rate', label: 'Late %', align: 'num', filter: 'range', value: (a) => Math.round(a.late_rate * 1000) / 10, render: (a) => pct(a.late_rate) },
            { key: 'top_cause', label: 'Top cause', filter: 'select', value: (a) => CAUSES[a.top_cause]?.label ?? '', render: (a) => <CauseTag cause={a.top_cause} /> },
            { key: 'complaints', label: 'Compl.', title: 'Formal complaints, last 90 days', align: 'num', filter: 'range', render: (a) => a.complaints || <span className="faint">—</span> },
            { key: 'penalties', label: 'Penalties', align: 'num', filter: 'range', render: (a) => (a.penalties ? usdK(a.penalties) : <span className="faint">—</span>) },
            { key: 'account_status', label: 'Status', filter: 'select', value: (a) => (a.account_status === 'threatening_to_leave' ? 'Threatening to leave' : 'Active'),
              render: (a) => (a.account_status === 'threatening_to_leave' ? <Badge tone="bad">At risk</Badge> : <Badge tone="good">Active</Badge>) },
          ]} />
      </Card>
      {open && <AccountDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function AccountDrawer({ id, onClose }) {
  const { data, error } = useApi(`/accounts/${id}`);
  const actions = data ? recommend(data) : [];
  const totalLate = data?.causes.reduce((s, c) => s + c.late, 0) || 1;
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <h3>{data?.client.client_name || id}</h3>
            {data && <div className="small muted">{data.client.account_tier} · {data.client.region} · {data.client.primary_order_channel} orders · {usd(data.client.annual_revenue_usd)}/yr {data.client.sla_penalty_clause === 'Y' && '· SLA penalty clause'}</div>}
          </div>
          <button className="btn sm" onClick={onClose}><X size={14} /></button>
        </div>
        {!data ? <Loading error={error} /> : (
          <div className="drawer-body stack">
            <div className="grid g4">
              <Kpi label="On-time" value={pct(1 - data.summary.late_rate)} tone={data.summary.late_rate > 0.25 ? 'bad' : 'good'} />
              <Kpi label="Late deliveries" value={num(data.summary.late)} sub={`of ${num(data.summary.deliveries)}`} />
              <Kpi label="Penalties" value={usdK(data.summary.penalties)} />
              <Kpi label="Complaints" value={data.complaints.length} />
            </div>

            <Card title="Recovery plan" sub="Generated from this account's own failure pattern.">
              <ul className="list-clean">
                {actions.map((a) => <li key={a.t}><span style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 0, background: 'var(--accent-soft)', color: 'var(--accent-ink)', flex: 'none' }}><Wrench size={14} /></span><div><b>{a.t}</b><div className="small muted">{a.d}</div></div></li>)}
              </ul>
            </Card>

            <div className="grid g2">
              <Card title="On-time by month">
                <ResponsiveContainer width="100%" height={190}>
                  <LineChart data={data.monthly} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="month" tickFormatter={(m) => new Date(`${m}-01T00:00`).toLocaleString('en-US', { month: 'short' })} {...axisX} />
                    <YAxis domain={[0.4, 1]} tickFormatter={(v) => pct(v, 0)} {...axisY} />
                    <Tooltip content={<ChartTip format={(v) => pct(v)} />} />
                    <ReferenceLine y={0.94} stroke={PAL.benchmark} strokeDasharray="4 4" strokeOpacity={0.6} />
                    <Line dataKey="on_time_rate" name="On-time" stroke={PAL.series[0]} {...lineProps} dot={{ ...lineProps.dot, fill: PAL.series[0] }} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
              <Card title="Why their deliveries were late">
                <div className="stack">
                  {data.causes.map((c) => (
                    <div key={c.cause}>
                      <div className="row between small"><span>{CAUSES[c.cause].label}</span><b>{num(c.late)}</b></div>
                      <Meter value={c.late / totalLate} color={CAUSES[c.cause].color} />
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card title="Complaints" sub="Last 90 days.">
              {data.complaints.length === 0 ? <div className="small muted">No formal complaints.</div> : (
                <ul className="list-clean">
                  {data.complaints.map((k) => (
                    <li key={k.complaint_id}><MessageSquareWarning size={15} style={{ color: 'var(--warn-ink)', marginTop: 2, flex: 'none' }} />
                      <div style={{ flex: 1 }}><div className="row between"><b>{k.category}</b><span className="small muted">{k.complaint_date} · {k.channel}{k.escalated_to_account_owner === 'Y' && ' · escalated'}</span></div>
                        <div className="small muted">"{k.text}" · {k.delivery_id}</div></div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Proactive notices sent">
              {data.notifications.length === 0 ? <div className="small muted">None yet. Send them from the control tower.</div> : (
                <ul className="list-clean">{data.notifications.map((n) => <li key={n.id}><Bell size={15} style={{ color: 'var(--good-ink)', marginTop: 2, flex: 'none' }} /><div><b>{n.delivery_id}</b> <span className="small muted">· {n.created_at} · {n.created_by}</span></div></li>)}</ul>
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

function recommend({ client, summary, carriers }) {
  const out = [];
  if (summary.address_rate > 0.15) out.push({ t: `Move off hand-keyed email orders (${pct(summary.address_rate, 0)} incomplete addresses)`, d: 'Onboard to the web form or API; until then every email order goes through intake validation.' });
  if (summary.cutoff_rate > 0.08) out.push({ t: `Stop promising same-day after 8am (${pct(summary.cutoff_rate, 0)} of orders)`, d: 'Agree a next-day default for late-morning orders, or a noon pick wave for this account.' });
  if (summary.stock_rate > 0.12) out.push({ t: `Add safety stock at the nearest warehouse (${pct(summary.stock_rate, 0)} stock-outs)`, d: 'Plan a transfer in Inventory placement and review monthly.' });
  const nonApi = carriers.filter((c) => ['D', 'E', 'F'].includes(c.carrier_id)).reduce((s, c) => s + c.n, 0) / carriers.reduce((s, c) => s + c.n, 0);
  if (nonApi > 0.25) out.push({ t: `Route time-critical orders to carriers A/B/C (${pct(nonApi, 0)} now on D/E/F)`, d: 'Apply the carrier scorecard rule at despatch.' });
  if (client.account_status === 'threatening_to_leave') out.push({ t: 'Named owner and weekly delivery report', d: 'Proactive notices on every high-risk order from the control tower.' });
  if (!out.length) out.push({ t: 'Monitor', d: 'No dominant failure pattern for this account.' });
  return out;
}
