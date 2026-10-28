import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import { ResponsiveContainer } from '../components/motion.jsx';
import { Bell, BellRing, Eye, EyeOff, Target, Radar, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api, useApi, pct, num, dt, COMMITMENT, PAL } from '../api.js';
import { PageHead, Card, Badge, RiskBadge, Loading, Toast, Kpi, Meter } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, gridProps, barProps, tip } from '../components/charts.jsx';

const DRIVER_LABEL = {
  address_incomplete: 'Address incomplete', cutoff_breach: 'After cutoff', stock_miss: 'Far warehouse', noapi_clean: 'No-API carrier',
  carrier_id: 'Carrier', order_channel: 'Channel', distance_miles: 'Distance', commitment_type: 'Service', received_dow: 'Day of week',
};
const draft = (r, now) => {
  const status = r.promised_date < now.slice(0, 10) ? 'is running late' : 'is at risk of arriving late';
  const why = [r.f_address && 'we are confirming the delivery address', r.f_stock && 'it is shipping from a more distant warehouse',
    r.f_cutoff && 'it missed this morning\'s pick list', r.f_carrier && 'the carrier has limited tracking'].filter(Boolean);
  return `Hello ${r.client_name} team,\n\nYour order ${r.order_id} (promised ${r.promised_date}) ${status} because ${why.join(' and ') || 'of a delay in transit'}. `
    + 'We are actively managing it and will update you as soon as it moves. Reply to this email if you need us to prioritise it.\n\nHalcyon Customer Success';
};

export default function ControlTower() {
  const { data, error, reload } = useApi('/exceptions');
  const [filter, setFilter] = useState('high');
  const [atRiskOnly, setAtRiskOnly] = useState(false);
  const [hindsight, setHindsight] = useState(false);
  const [compose, setCompose] = useState(null);
  const [toast, setToast] = useState('');

  const rows = useMemo(() => (data?.rows || []).filter((r) => (filter === 'all' || r.risk >= data.threshold)
    && (!atRiskOnly || r.account_status === 'threatening_to_leave')), [data, filter, atRiskOnly]);
  if (!data) return <Loading error={error} />;
  const { model } = data;
  const notified = data.rows.filter((r) => r.notified_at).length;
  const pendingSla = data.rows.filter((r) => r.risk >= data.threshold && r.sla_penalty_clause === 'Y' && !r.notified_at);
  const histogram = Array.from({ length: 10 }, (_, i) => ({
    bin: i / 10, label: `${i * 10}–${i * 10 + 10}%`, n: data.rows.filter((r) => Math.min(9, Math.floor(r.risk * 10)) === i).length,
  }));
  const reasons = Object.entries(data.rows.filter((r) => r.risk >= data.threshold).flatMap((r) => r.drivers.map((d) => d.feature))
    .reduce((m, f) => ({ ...m, [f]: (m[f] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const send = async (r, message) => {
    await api(`/exceptions/${r.delivery_id}/notify`, { method: 'POST', body: { message } });
    setCompose(null); setToast(`Notification sent to ${r.client_name}`); reload();
  };
  const sendAll = async () => {
    await Promise.all(pendingSla.map((r) => api(`/exceptions/${r.delivery_id}/notify`, { method: 'POST', body: { message: draft(r, data.now), created_by: 'Bulk: high-risk SLA' } })));
    setToast(`${pendingSla.length} SLA clients notified before their promised date`); reload();
  };

  return (
    <>
      <PageHead title="Exceptions control tower" eyebrow={`Fix · I5 · snapshot ${data.now}`}
        actions={<button className="btn primary" disabled={!pendingSla.length} onClick={sendAll}><BellRing size={15} /> Notify {pendingSla.length} high-risk SLA orders</button>}>
        Every order in flight is scored by the AI risk model for its chance of arriving late, with the reasons behind each score,
        so clients hear about a likely delay before they have to chase.
      </PageHead>

      <div className="grid g4 section-gap">
        <Kpi icon={Radar} label="Orders in flight" value={num(model.in_flight)} sub="Received, not yet delivered" />
        <Kpi icon={AlertTriangle} label="Flagged high risk" value={num(model.flagged)} sub={`Risk at or above ${pct(data.threshold, 0)}`} tone="warn" bar={model.flagged / model.in_flight} />
        <Kpi icon={CheckCircle2} label="Clients notified" value={num(notified)} sub="Proactive notices sent" tone="good" />
        <Card>
          <div className="row small" style={{ gap: 7, color: 'var(--ink-2)', fontWeight: 500 }}><Target size={14} color="var(--muted)" /> Model check, in hindsight</div>
          <div className="grid g2" style={{ gap: 12, marginTop: 12 }}>
            <div><div style={{ fontSize: 28, fontWeight: 600, }}>{pct(model.precision, 0)}</div><div className="small muted">of flagged orders were late</div></div>
            <div><div style={{ fontSize: 28, fontWeight: 600, }}>{pct(model.recall, 0)}</div><div className="small muted">of late orders were flagged</div></div>
          </div>
        </Card>
      </div>

      <div className="grid g3 section-gap">
        <Card className="span2" title="Risk distribution of orders in flight" sub={`Orders at or above ${pct(data.threshold, 0)} risk go on the watchlist.`}>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={histogram} margin={{ top: 10, right: 8, left: -8, bottom: 0 }} barCategoryGap="12%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="label" {...axisX} interval={0} />
              <YAxis {...axisY} />
              {tip((v) => `${num(v)} orders`, (l) => `Risk ${l}`)}
              <ReferenceLine x="40–50%" stroke={PAL.ink2} strokeOpacity={0.4} />
              <Bar dataKey="n" name="Orders" {...barProps}>
                {histogram.map((h) => <Cell key={h.label} fill={h.bin >= data.threshold ? PAL.series[1] : PAL.neutral} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Why orders are on the watchlist" sub="Most common model reasons among high-risk orders.">
          <div className="stack">
            {reasons.map(([f, n]) => (
              <div key={f}>
                <div className="row between small" style={{ marginBottom: 4 }}><span>{DRIVER_LABEL[f] || f}</span><b className="num-tab">{num(n)}</b></div>
                <Meter value={n} max={reasons[0][1]} color={PAL.series[1]} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Order watchlist" sub="At-risk accounts first, then by risk. Use the column filters to narrow by client, carrier, service or reason.">
        <DataTable rows={rows} rowKey={(r) => r.delivery_id} pageSize={25} exportName="control-tower-watchlist" searchPlaceholder="Client, order or delivery"
          toolbar={(
            <>
              <div className="seg">
                <button className={filter === 'high' ? 'on' : ''} onClick={() => setFilter('high')}>High risk</button>
                <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All in flight</button>
              </div>
              <button className={`btn sm ${atRiskOnly ? 'primary' : ''}`} onClick={() => setAtRiskOnly(!atRiskOnly)}>At-risk accounts</button>
              <button className="btn sm" onClick={() => setHindsight(!hindsight)}>{hindsight ? <EyeOff size={13} /> : <Eye size={13} />} Actual outcome</button>
            </>
          )}
          columns={[
            { key: 'delivery_id', label: 'Order', value: (r) => r.delivery_id,
              render: (r) => <><span className="mono">{r.delivery_id}</span><div className="small muted">{dt(r.order_received_ts)}</div></> },
            { key: 'client_name', label: 'Client', render: (r) => (
              <>{r.client_name}<div className="row" style={{ gap: 4, marginTop: 3 }}>
                {r.sla_penalty_clause === 'Y' && <Badge tone="brand">SLA</Badge>}{r.account_status === 'threatening_to_leave' && <Badge tone="bad">at risk</Badge>}
              </div></>) },
            { key: 'account_tier', label: 'Tier', filter: 'select' },
            { key: 'commitment_type', label: 'Service', filter: 'select', value: (r) => COMMITMENT[r.commitment_type] },
            { key: 'promised_date', label: 'Promised', render: (r) => (
              <>{r.promised_date}{r.promised_date < data.now.slice(0, 10) && <div><Badge tone="bad">Overdue</Badge></div>}</>) },
            { key: 'carrier_id', label: 'Carrier', filter: 'select', render: (r) => (
              <span className="small">Carrier {r.carrier_id}<div className="muted">{r.fulfilment_warehouse_id} → {r.destination_region}</div></span>) },
            { key: 'drivers', label: 'Why at risk', sortable: false, value: (r) => r.drivers.map((d) => DRIVER_LABEL[d.feature] || d.feature).join(', '),
              render: (r) => <div className="row wrap" style={{ gap: 4, whiteSpace: 'normal', minWidth: 190, maxWidth: 240 }}>{r.drivers.map((d) => <Badge key={d.feature} tone="warn">{DRIVER_LABEL[d.feature] || d.feature} +{Math.round(d.impact * 100)}</Badge>)}</div> },
            { key: 'risk', label: 'ML risk %', align: 'num', filter: 'range', value: (r) => Math.round(r.risk * 100), render: (r) => <RiskBadge risk={r.risk} /> },
            ...(hindsight ? [{ key: 'actual_late', label: 'Actual', filter: 'select', value: (r) => (r.actual_late ? 'Late' : 'On time'),
              render: (r) => (r.actual_late ? <Badge tone="bad">{r.actual_days_late}d late</Badge> : <Badge tone="good">on time</Badge>) }] : []),
            { key: 'notified_at', label: 'Notice', filter: 'select', value: (r) => (r.notified_at ? 'Notified' : 'Not yet'),
              render: (r) => (r.notified_at ? <Badge tone="good"><Bell size={11} /> Notified</Badge>
                : <button className="btn sm" onClick={() => setCompose({ r, message: draft(r, data.now) })}><Bell size={13} /> Notify</button>) },
          ]} />
      </Card>

      {compose && (
        <>
          <div className="drawer-bg" onClick={() => setCompose(null)} />
          <div className="drawer" style={{ width: 540 }}>
            <div className="drawer-head"><div><h3>Proactive delay notice</h3><div className="small muted">To {compose.r.client_name} · order {compose.r.order_id}</div></div>
              <button className="btn sm" onClick={() => setCompose(null)}>Close</button></div>
            <div className="drawer-body stack">
              <div className="row small" style={{ gap: 8 }}><RiskBadge risk={compose.r.risk} />{compose.r.drivers.map((d) => <Badge key={d.feature} tone="warn">{DRIVER_LABEL[d.feature] || d.feature}</Badge>)}</div>
              <textarea className="input" rows={12} value={compose.message} onChange={(e) => setCompose({ ...compose, message: e.target.value })} style={{ fontFamily: 'var(--font)', fontSize: 14 }} />
              <button className="btn primary" onClick={() => send(compose.r, compose.message)}><Bell size={14} /> Send notice</button>
              <p className="small muted">Demo: notices are recorded against the account, not emailed.</p>
            </div>
          </div>
        </>
      )}
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}
