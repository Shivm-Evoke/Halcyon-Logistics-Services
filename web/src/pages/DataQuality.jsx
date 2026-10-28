import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, Tooltip } from 'recharts';
import { ResponsiveContainer } from '../components/motion.jsx';
import { ShieldAlert, ShieldCheck, ScanSearch, Gauge, X } from 'lucide-react';
import { useApi, pct, num, dt, PAL } from '../api.js';
import { PageHead, Card, Kpi, Badge, Loading } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, hbarProps, ChartTip, Legend } from '../components/charts.jsx';

const SEV_TONE = { high: 'bad', medium: 'warn', low: 'neutral' };
// Severity is a status, so it uses the reserved status colours, always next to a text label.
const SEV_COLOR = { get high() { return PAL.status.critical; }, get medium() { return PAL.status.serious; }, get low() { return PAL.neutral; } };
const CODE_LABEL = {
  address_incomplete: 'Address incomplete', address_invalid: 'Address invalid', impossible_promise: 'Same-day after cutoff',
  duplicate_order_id: 'Order ID used by another client', unusual_destination: 'Unusual destination for client',
  unusual_channel: 'Unusual order channel', unusual_service: 'Unusual service level', unusual_time: 'Unusual order time',
  unknown_client: 'Unknown client',
};

export default function DataQuality() {
  const scan = useApi('/quality/scan');
  const [code, setCode] = useState('');
  const anomalies = useApi(`/quality/anomalies${code ? `?code=${code}` : ''}`);
  const [check, setCheck] = useState(null);
  if (!scan.data || !anomalies.data) return <Loading error={scan.error || anomalies.error} />;
  const checks = scan.data.checks;
  const failing = checks.filter((c) => c.count > 0);
  const a = anomalies.data;

  return (
    <>
      <PageHead title="Data quality" eyebrow="AI · I10 · checks on every record">
        Every record from clients, the WMS and carriers is checked automatically. Rule checks catch broken records; the client profiler
        flags orders that don't look like that client's normal orders, so they can be bounced back or fixed before they ship.
      </PageHead>

      <div className="grid g4 section-gap">
        <Kpi icon={ShieldAlert} label="Checks failing" value={`${failing.length} of ${checks.length}`} sub={`Scanned in ${scan.data.ms} ms`} tone="warn" bar={failing.length / checks.length} />
        <Kpi icon={ScanSearch} label="Incoming orders flagged" value={pct(a.flagged / a.screened, 0)} sub={`${num(a.flagged)} of ${num(a.screened)} September orders`} />
        <Kpi icon={ShieldCheck} label="Late rate: flagged vs clean" value={`${pct(a.late_rate_flagged, 0)} vs ${pct(a.late_rate_clean, 0)}`} sub="The flags pick out the orders that fail" tone="bad" />
        <Kpi icon={Gauge} label="Screening speed" value={`${((a.ms_total * 1000) / a.screened).toFixed(1)} µs`} sub="Per order" tone="good" />
      </div>

      <Card title="Rule checks on the ingested data" className="section-gap" sub="Click a failing check to see the records behind it. Each names the system the problem comes from.">
        <DataTable rows={checks} rowKey={(c) => c.id} search={false} pageSize={25} onRowClick={(c) => c.count && setCheck(c)} initialSort={{ key: 'count', dir: 'desc' }}
          columns={[
            { key: 'severity', label: 'Severity', filter: 'select', value: (c) => (c.count ? c.severity : 'pass'),
              render: (c) => <Badge tone={c.count ? SEV_TONE[c.severity] : 'good'}>{c.count ? c.severity : 'pass'}</Badge> },
            { key: 'title', label: 'Check', render: (c) => <b>{c.title}</b> },
            { key: 'source', label: 'Source', filter: 'select', render: (c) => <span className="muted">{c.source}</span> },
            { key: 'count', label: 'Records', align: 'num', filter: 'range', render: (c) => (c.count ? <b>{num(c.count)}</b> : <span className="faint">—</span>) },
            { key: 'why', label: 'Why it matters', filter: false, sortable: false,
              render: (c) => <span className="small muted" style={{ whiteSpace: 'normal', display: 'block', minWidth: 220, maxWidth: 360 }}>{c.why}</span> },
          ]} />
      </Card>

      <div className="grid g3 section-gap">
        <Card title="What the anomaly screen found" sub="September orders against each client's April–August pattern. Click a bar to filter the list below.">
          <Legend items={[{ label: 'High', color: SEV_COLOR.high }, { label: 'Medium', color: SEV_COLOR.medium }, { label: 'Low', color: SEV_COLOR.low }]} />
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={a.by_code.map((c) => ({ ...c, label: CODE_LABEL[c.code] || c.code }))} layout="vertical" margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={PAL.grid} horizontal={false} />
              <XAxis type="number" {...axisX} />
              <YAxis type="category" dataKey="label" {...axisY} width={170} tick={{ fontSize: 12, fill: PAL.ink2 }} />
              <Tooltip cursor={{ fill: PAL.cursor }} content={<ChartTip format={(v) => `${num(v)} orders`} />} />
              <Bar dataKey="count" name="Orders" {...hbarProps} maxBarSize={20} cursor="pointer" onClick={(d) => setCode(code === d.code ? '' : d.code)}>
                {a.by_code.map((c) => <Cell key={c.code} fill={SEV_COLOR[c.severity]} opacity={!code || code === c.code ? 1 : 0.3} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card className="span2" title="Clients sending the most problem orders" sub="Who to contact first: flagged orders, weighted by severity.">
          <DataTable rows={a.by_client} rowKey={(c) => c.client_id} pageSize={10} search={false} showFilters={false} initialSort={{ key: 'score', dir: 'desc' }}
            columns={[
              { key: 'client_name', label: 'Client' },
              { key: 'orders', label: 'Orders', align: 'num', filter: 'range', render: (c) => num(c.orders) },
              { key: 'flagged', label: 'Flagged', align: 'num', filter: 'range', render: (c) => num(c.flagged) },
              { key: 'share', label: 'Share', align: 'num', filter: 'range', value: (c) => Math.round((c.flagged / c.orders) * 100), render: (c) => pct(c.flagged / c.orders, 0) },
              { key: 'score', label: 'Severity score', align: 'num', filter: 'range', render: (c) => <b>{c.score}</b> },
            ]} />
        </Card>
      </div>

      <Card title={`Flagged incoming orders${code ? ` · ${CODE_LABEL[code]}` : ''}`}
        sub={`${num(a.matching)} orders, highest severity first${a.matching > a.rows.length ? ` (top ${a.rows.length} shown)` : ''}. "Outcome" is what really happened, shown to prove the flags matter.`}
        actions={code && <button className="btn sm" onClick={() => setCode('')}><X size={13} /> Clear chart filter</button>}>
        <DataTable rows={a.rows} rowKey={(r) => r.delivery_id} pageSize={25} exportName="flagged-orders" searchPlaceholder="Order or client"
          columns={[
            { key: 'delivery_id', label: 'Order', render: (r) => <><span className="mono">{r.delivery_id}</span><div className="small muted mono">{r.order_id}</div></> },
            { key: 'client_name', label: 'Client' },
            { key: 'received', label: 'Received', render: (r) => dt(r.received) },
            { key: 'channel', label: 'Channel', filter: 'select' },
            { key: 'region', label: 'Destination', filter: 'select' },
            { key: 'findings', label: 'Findings', sortable: false, filter: 'select', value: (r) => r.findings.map((f) => CODE_LABEL[f.code] || f.code).join(', '),
              options: Object.entries(CODE_LABEL).filter(([k]) => a.by_code.some((c) => c.code === k)).map(([, l]) => ({ value: l, label: l })),
              render: (r) => <div className="row wrap" style={{ gap: 4, whiteSpace: 'normal', maxWidth: 420 }}>{r.findings.map((f) => <span key={f.code} title={f.message}><Badge tone={SEV_TONE[f.severity]}>{CODE_LABEL[f.code] || f.code}</Badge></span>)}</div> },
            { key: 'late', label: 'Outcome', filter: 'select', value: (r) => (r.late ? 'Late' : 'On time'),
              render: (r) => (r.late ? <Badge tone="bad">late</Badge> : <Badge tone="good">on time</Badge>) },
          ]} />
      </Card>

      {check && <CheckDrawer check={check} onClose={() => setCheck(null)} />}
    </>
  );
}

function CheckDrawer({ check, onClose }) {
  const { data, error } = useApi(`/quality/checks/${check.id}`);
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div><h3>{check.title}</h3><div className="small muted">{num(check.count)} records · {check.source}</div></div>
          <button className="btn sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="drawer-body stack">
          <div className="callout warn">{check.why}</div>
          {!data ? <Loading error={error} /> : (
            <DataTable rows={data} rowKey={(r) => r.ref} pageSize={25} exportName={`check-${check.id}`} searchPlaceholder="Record, client or detail"
              columns={[
                { key: 'ref', label: 'Record', render: (r) => <span className="mono">{r.ref}</span> },
                { key: 'client_id', label: 'Client', filter: 'select' },
                { key: 'detail', label: 'Detail', render: (r) => <span className="small">{r.detail}</span> },
              ]} />
          )}
          {data && check.count > data.length && <p className="small muted">Showing the first {data.length} of {num(check.count)}.</p>}
        </div>
      </div>
    </>
  );
}
