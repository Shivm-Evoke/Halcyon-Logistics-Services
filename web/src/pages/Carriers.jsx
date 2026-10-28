import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ResponsiveContainer } from '../components/motion.jsx';
import { Trophy, Ban } from 'lucide-react';
import { api, useApi, pct, num, COMMITMENT, PAL } from '../api.js';
import { PageHead, Card, Badge, Loading } from '../components/ui.jsx';
import DataTable from '../components/DataTable.jsx';
import { axisX, axisY, gridProps, barProps, tip, Legend } from '../components/charts.jsx';

const carrierColor = (c) => PAL.series['ABCDEF'.indexOf(c)];

export default function Carriers() {
  const { data, error } = useApi('/carriers/scorecard');
  const accounts = useApi('/accounts');
  const [rec, setRec] = useState({ client_id: 'C190', commitment_type: 'next_day' });
  const [ranked, setRanked] = useState(null);
  useEffect(() => { api('/carriers/recommend', { method: 'POST', body: rec }).then(setRanked); }, [rec]);
  if (!data) return <Loading error={error} />;
  const { carriers, lateness, misallocated, threshold } = data;
  const dist = [1, 2, 3, 4].map((d) => ({
    days: `${d} day${d > 1 ? 's' : ''} late`,
    ...Object.fromEntries(carriers.map((c) => [c.carrier_id, lateness.find((l) => l.carrier_id === c.carrier_id && l.days_late === d)?.n ?? 0])),
  }));
  const client = accounts.data?.find((a) => a.client_id === rec.client_id);

  return (
    <>
      <PageHead title="Carrier scorecard" eyebrow="Fix · I4 · 27% of late deliveries">
        Carriers are chosen on expected cost, meaning rate plus the cost of being late, instead of rate alone. Same-day and next-day orders
        only go to carriers late on fewer than {pct(threshold, 0)} of clean orders.
      </PageHead>

      <div className="callout warn section-gap">
        <Ban size={18} />
        <div>
          <b>{pct(misallocated.to_non_api / misallocated.time_critical, 0)} of same-day and next-day orders ({num(misallocated.to_non_api)}) went to carriers D, E or F</b>,
          the three with no tracking API. D is the cheapest on the rate card and the slowest of all six; F is the new preferred supplier.
        </div>
      </div>

      <Card title="Scorecard, six months" className="section-gap"
        sub="'Clean' orders have no address, cutoff or stock problem, so any difference is down to the carrier.">
        <DataTable compact rows={carriers} rowKey={(r) => r.carrier_id} initialSort={{ key: 'carrier_id', dir: 'asc' }}
          columns={[
            { key: 'carrier_id', label: 'Carrier', render: (c) => (
              <span className="row" style={{ gap: 8 }}><span className="dot" style={{ background: carrierColor(c.carrier_id) }} /><b>{c.carrier_name}</b>
                {c.preferred_supplier_agreement === 'Y' && <Badge tone="warn">preferred</Badge>}</span>) },
            { key: 'delivery_event_feed', label: 'Feed', render: (c) => (c.has_api === 'Y' ? <Badge tone="good">API</Badge> : <Badge tone="bad">{c.delivery_event_feed}</Badge>) },
            { key: 'deliveries', label: 'Deliveries', align: 'num', render: (c) => num(c.deliveries) },
            { key: 'avg_rate', label: 'Avg rate', align: 'num', render: (c) => `$${Number(c.avg_rate).toFixed(2)}` },
            { key: 'late_rate', label: 'Late, all', align: 'num', render: (c) => pct(c.late_rate) },
            { key: 'clean_late_rate', label: 'Late, clean', align: 'num',
              render: (c) => <b style={{ color: c.time_critical_eligible ? 'var(--good-ink)' : 'var(--bad-ink)' }}>{pct(c.clean_late_rate)}</b> },
            { key: 'avg_days_late', label: 'Days late', align: 'num', render: (c) => Number(c.avg_days_late).toFixed(1) },
            { key: 'expected_cost_sla', label: 'Cost / SLA order', title: 'Rate plus expected late cost for a client with an SLA penalty clause', align: 'num', render: (c) => `$${c.expected_cost_sla.toFixed(2)}` },
            { key: 'time_critical_eligible', label: 'Time-critical', value: (c) => (c.time_critical_eligible ? 'Eligible' : 'Standard only'),
              render: (c) => (c.time_critical_eligible ? <Badge tone="good">Eligible</Badge> : <Badge tone="bad">Standard only</Badge>) },
          ]} />
      </Card>

      <div className="grid g2">
        <Card title="How late are late clean deliveries?" sub="D, E and F cluster at 2–4 days late: either real delay, or delivery events reported late by portal or batch file (question Q-011).">
          <Legend items={carriers.map((c) => ({ label: `Carrier ${c.carrier_id}`, color: carrierColor(c.carrier_id) }))} />
          <ResponsiveContainer width="100%" height={292}>
            <BarChart data={dist} margin={{ top: 14, right: 8, left: -8, bottom: 0 }} barCategoryGap="22%" barGap={2}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="days" {...axisX} />
              <YAxis {...axisY} />
              {tip((v) => `${num(v)} deliveries`)}
              {carriers.map((c) => <Bar key={c.carrier_id} dataKey={c.carrier_id} name={`Carrier ${c.carrier_id}`} fill={carrierColor(c.carrier_id)} {...barProps} maxBarSize={16} />)}
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Despatch: recommended carrier" sub="What the warehouse team sees at despatch instead of the preference spreadsheet.">
          <div className="grid g2" style={{ marginBottom: 12 }}>
            <label className="field">Client
              <select className="input" value={rec.client_id} onChange={(e) => setRec({ ...rec, client_id: e.target.value })}>
                {accounts.data?.map((a) => <option key={a.client_id} value={a.client_id}>{a.client_name} · {a.account_tier}{a.sla_penalty_clause === 'Y' ? ' · SLA' : ''}</option>)}
              </select>
            </label>
            <label className="field">Service
              <select className="input" value={rec.commitment_type} onChange={(e) => setRec({ ...rec, commitment_type: e.target.value })}>
                {Object.entries(COMMITMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
          {client && <p className="small muted" style={{ margin: '0 0 12px' }}>Cost of a late delivery: $34 redelivery{client.sla_penalty_clause === 'Y' ? ' + $180 SLA penalty' : ''}, times the chance of being late.</p>}
          {ranked && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Carrier</th><th className="num">Rate</th><th className="num">P(late)</th><th className="num">Exp. cost</th><th /></tr></thead>
                <tbody>
                  {ranked.map((c, i) => (
                    <tr key={c.carrier_id} style={{ opacity: c.eligible ? 1 : 0.5 }}>
                      <td>{i === 0 ? <Trophy size={15} color={PAL.trophy} /> : <span className="muted">{i + 1}</span>}</td>
                      <td><span className="row" style={{ gap: 8 }}><span className="dot" style={{ background: carrierColor(c.carrier_id) }} /><b>{c.carrier_name}</b></span></td>
                      <td className="num">${Number(c.avg_rate).toFixed(2)}</td>
                      <td className="num">{pct(c.clean_late_rate)}</td>
                      <td className="num"><b>${c.expected_cost.toFixed(2)}</b></td>
                      <td>{c.eligible ? (i === 0 ? <Badge tone="good">Recommended</Badge> : null) : <Badge tone="bad">Excluded</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
